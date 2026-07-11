# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Local Runtime Overrides

- Observer SDK subprocesses use `~/.claude-mem/observer-claude-config` as their private `CLAUDE_CONFIG_DIR` so internal sessions do not appear in CC Switch.
- `CLAUDE_MEM_PROVIDER=codex` runs observation and summary work through the logged-in Codex CLI. It does not automatically fall back to Claude; quota failures retain queued work and apply a five-minute retry cooldown.
- Codex defaults are `CLAUDE_MEM_CODEX_MODEL=gpt-5.6-luna` and `CLAUDE_MEM_CODEX_REASONING_EFFORT=medium`. Each call is ephemeral, read-only, approval-free, suppresses recursive claude-mem hooks, skips the empty init call, and is capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`.
- When `CLAUDE_MEM_SUMMARY_PROVIDER=codex`, summary batches use `CLAUDE_MEM_SUMMARY_MODEL` and `CLAUDE_MEM_SUMMARY_EFFORT`; observation batches continue to use the regular Codex model and effort settings.
- `CLAUDE_MEM_PROVIDER=grok` runs observation and summary work through the logged-in Grok CLI (`grok --prompt-file`, membership/session auth). Defaults: `CLAUDE_MEM_GROK_MODEL=grok-4.5`, `CLAUDE_MEM_GROK_REASONING_EFFORT=medium`. Stateless single-shot mode: **skips the huge init skeleton LLM call**, sends only the latest observation/summary task with a short protocol system prompt (prompt clipped to ~24k chars), `--tools "" --max-turns 5 --no-memory`, `GROK_HOME=~/.claude-mem/observer-grok-home` (auth symlinked from real `~/.grok`), temp cwd. Concurrency capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` with query-time cooldown checks. Format salvage rewrites observation-shaped `<summary>` into protocol summary fields. Transcript watcher skips ephemeral `/var/folders` / `claude-mem-grok-*` session paths to avoid ENOENT spam.
- Grok project sessions can be captured via transcript watch on `~/.grok/sessions/**/updates.jsonl` (`platform_source=grok`).
- Generator exits that leave buffered work behind (quota, exec timeout, spawn failure) preserve the session and its in-RAM buffer instead of finalizing; the next ingest or `POST /api/sessions/init` (with matching `platformSource`) restarts the generator. Only a clean exit with an empty buffer finalizes. The queue is in-memory only — restarting the worker drops it.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Important

No need to edit the changelog ever, it's generated automatically.

## Local Status Notes

- 2026-06-15: Issue #2909 is intentionally split. PR #2919 covers session-isolation/read-path behavior, while target 29 covers the observer `.jsonl` accumulation half by disabling session persistence for observer tool-use SDK queries.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`, `openclaw/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.
