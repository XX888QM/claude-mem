"""Run: python3 tests/grok-observer-refresh.test.py (no network or real credentials)."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts/grok-observer"
PROGRAM = SOURCE.read_text().split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY\n", 1)[0]


def check(*, expired=False, rejected=False, refresh_fails=False, unchanged=False,
          soon=False, status=403, denied=False, concurrent=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        auth_path = root / ".grok/auth.json"
        auth_path.parent.mkdir()
        entry = {"key": "old-test-token", "refresh_token": "test-refresh",
                 "expires_at": "2000-01-01T00:00:00Z" if expired else "2999-01-01T00:00:00Z"}
        if soon:
            entry["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()
        auth_path.write_text(json.dumps({"test-provider": entry}))
        prompt = root / "prompt.txt"
        prompt.write_text("Reply OK")
        env = {"REAL_HOME": directory, "REAL_GROK": str(root / "grok"),
               "HOME": str(root / "isolated"), "GROK_HOME": str(root / "isolated"),
               "AUTH_JSON": str(auth_path), "PROMPT_FILE": str(prompt), "MODEL": "grok-4.5",
               "TOKEN_LOG": str(root / "tokens"), "CLAUDE_MEM_GROK_OBSERVER_LOG": str(root / "log")}
        calls = []
        requests = []

        def refresh(command, **kwargs):
            calls.append(command)
            assert command == [str(root / "grok"), "models"]
            assert kwargs["env"]["HOME"] == directory
            assert kwargs["env"]["GROK_AUTH_EARLY_INVALIDATION_SECS"] == "300"
            assert "GROK_HOME" not in kwargs["env"]
            assert kwargs["stdin"] == subprocess.DEVNULL
            assert 0 < kwargs["timeout"] <= 60
            if refresh_fails:
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            if not unchanged:
                entry.update(key="fresh-test-token", expires_at="2999-01-01T00:00:00Z")
                temporary = auth_path.with_suffix(".tmp")
                temporary.write_text(json.dumps({"test-provider": entry}))
                temporary.replace(auth_path)
            return subprocess.CompletedProcess(command, 0)

        def request(req, **kwargs):
            token = req.get_header("Authorization")
            requests.append(token)
            if denied:
                raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {},
                                             io.BytesIO(b'{"code":"permission-denied"}'))
            if (expired or rejected) and token == "Bearer old-test-token":
                raise urllib.error.HTTPError(req.full_url, status, "Forbidden", {},
                                             io.BytesIO(b'{"code":"unauthenticated:bad-credentials"}'))
            return io.BytesIO(b'{"choices":[{"message":{"content":"OK"}}]}')

        stdout, stderr = io.StringIO(), io.StringIO()
        exit_code = 0
        with patch.dict(os.environ, env, clear=True), patch("subprocess.run", side_effect=refresh), \
                patch("urllib.request.urlopen", side_effect=request), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                namespace = {"__name__": "__main__"}
                exec(compile(PROGRAM, str(SOURCE), "exec"), namespace)
                if concurrent:
                    entry.update(key="old-test-token", expires_at="2000-01-01T00:00:00Z")
                    auth_path.write_text(json.dumps({"test-provider": entry}))
                    with ThreadPoolExecutor(max_workers=6) as pool:
                        assert list(pool.map(lambda _: namespace["get_token"](), range(6))) == ["fresh-test-token"] * 6
            except SystemExit as error:
                exit_code = error.code
        if refresh_fails or unchanged or denied:
            assert exit_code != 0, "failed renewal must fail closed"
            assert auth_path.exists(), "failed renewal must not delete credentials"
        else:
            assert exit_code == 0, stderr.getvalue()
            assert stdout.getvalue().strip() == "OK"
        assert len(calls) == int(expired or rejected or soon or concurrent), calls
        assert len(requests) <= 2, "authentication retry must be bounded"
        combined = stdout.getvalue() + stderr.getvalue()
        if (root / "log").exists():
            combined += (root / "log").read_text()
        for secret in ("old-test-token", "fresh-test-token", "test-refresh"):
            assert secret not in combined, "credentials must not be logged"


if __name__ == "__main__":
    check(expired=True)
    check()
    check(rejected=True)
    check(expired=True, refresh_fails=True)
    check(expired=True, unchanged=True)
    check(soon=True)
    check(rejected=True, status=401)
    check(denied=True)
    check(concurrent=True)
    print("9 observer refresh checks passed")
