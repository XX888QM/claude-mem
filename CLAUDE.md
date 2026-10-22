# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations, and injects relevant context into future sessions. This fork must not spend Claude subscription quota.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Repository Ownership and Official Updates

- This checkout has one configured Git remote: `origin` → `https://github.com/XX888QM/claude-mem.git`.
- Do not add the official repository as a persistent remote and never push to it. The official source is kept only as a reference URL: `https://github.com/thedotmack/claude-mem.git`.
- When the official project updates, fetch it temporarily, review the diff, and bring over only the useful, compatible changes. Do not blindly merge the whole official branch because this fork carries Codex, Grok, queue, and project-attribution customizations.

```bash
git fetch https://github.com/thedotmack/claude-mem.git main
git log --oneline HEAD..FETCH_HEAD
git diff --stat HEAD...FETCH_HEAD
# Cherry-pick a suitable complete official commit, or port only the reviewed files.
```

## Known Pitfalls (learned the hard way)

- **Codex plugin cache drifts silently.** `~/.codex/plugins/cache/claude-mem-local/claude-mem/<version>/` contains a full git-less copy of the plugin root, not a symlink. Matching version numbers or matching marketplace/Claude-cache hashes does NOT prove the Codex cache is in sync — hash `scripts/worker-service.cjs` in the actual registered version directory after installation.
- **`--process` queue-drain trigger returns 404.** The non-interactive force-process path hits `/api/queue`, which isn't implemented on the worker. Don't rely on it to force-drain a stuck queue; check worker health/logs instead.
- **Never `git stash pop` onto the official-merge upgrade branch.** Doing this once produced massive both-modified conflicts across plugin metadata, docs, package.json version, worker/MCP services, HTTP middleware, and settings defaults. Follow the fetch-and-cherry-pick flow in "Repository Ownership" instead — never a blanket stash/merge of the whole official tree.
- **When resolving merge conflicts, don't blanket-keep "ours."** Diff each contested hunk before discarding the official side — upstream security fixes (e.g. remote read-only token guard, TV empty-token deny) can look like noise in a conflict marker and get dropped by reflex.

## Local Runtime Overrides

- **不准用 Claude 额度。** `~/.claude-mem/settings.json` 必须保持 `CLAUDE_MEM_DISALLOW_CLAUDE_QUOTA=true`，观察和总结走 `CLAUDE_MEM_PROVIDER=grok`（或 `codex`）。选中 `claude` 时 Worker 拒绝启动 Claude Agent SDK，队列留着，不扣订阅额度。知识库 `prime` / `query` 同样不准走 Claude SDK，用 `get_corpus`。不要用没带这个拒绝逻辑的官方原包替换正在跑的 Worker。
- Observer SDK subprocesses use `~/.claude-mem/observer-claude-config` as their private `CLAUDE_CONFIG_DIR` so internal sessions do not appear in CC Switch.
- `CLAUDE_MEM_PROVIDER=codex` runs observation and summary work through the logged-in Codex CLI. It does not automatically fall back to Claude; quota failures retain queued work and apply a five-minute retry cooldown. On macOS, daemon installs prefer the regular PATH/npm Codex CLI, then use the `ChatGPT.app` bundle as a last-resort fallback because some daemon contexts report `ENOENT` for the bundled executable.
- Codex defaults are `CLAUDE_MEM_CODEX_MODEL=gpt-5.6-luna` and `CLAUDE_MEM_CODEX_REASONING_EFFORT=medium`. Each call is ephemeral, read-only, approval-free, runs below `~/.claude-mem/observer-sessions` so recursive claude-mem hooks are filtered even when the CLI strips environment flags, skips the empty init call, and is capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`.
- When `CLAUDE_MEM_SUMMARY_PROVIDER=codex` (or `grok`), summary batches use `CLAUDE_MEM_SUMMARY_MODEL` and `CLAUDE_MEM_SUMMARY_EFFORT` via each provider's `getSummaryConfig` override; observation batches continue to use the regular provider model and effort settings.
- `CLAUDE_MEM_PROVIDER=grok` runs observation and summary work through the logged-in Grok CLI (`grok --prompt-file`, membership/session auth). Defaults: `CLAUDE_MEM_GROK_MODEL=grok-4.5`, `CLAUDE_MEM_GROK_REASONING_EFFORT=medium` (the CLI accepts only `low`/`medium`/`high`; anything else normalizes to `medium` because the CLI exits 1 on unknown effort levels). Stateless single-shot mode: **skips the huge init skeleton LLM call**, sends only the latest observation/summary task with a short protocol system prompt (prompt clipped to ~24k chars), `--tools "" --max-turns 5 --no-memory`, an ephemeral `HOME`/`GROK_HOME` (auth/models cache symlinked from `~/.grok`, no user `config.toml` / MCP), and an ephemeral cwd under `/tmp/claude-mem-grok-*` so the CLI does not walk `~/.claude-mem` or start the user's MCP servers. If `~/.claude-mem/bin/grok-observer` exists, observer/summary calls use that wrapper (direct `api.x.ai`) instead of the Grok CLI, because the CLI's `cli-chat-proxy.grok.com` path hangs inside the worker. Default exec timeout is 6 minutes (`CLAUDE_MEM_GROK_EXEC_TIMEOUT_MS`). Concurrency capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` with query-time cooldown checks. Format salvage rewrites observation-shaped `<summary>` into protocol summary fields. Transcript watcher skips legacy ephemeral `/var/folders` / `claude-mem-grok-*` session paths to avoid ENOENT spam.
- Codex hooks resolve the local Codex cache (`~/.codex/plugins/cache/claude-mem-local/claude-mem`) before Claude's cache and the marketplace, preventing an older Claude plugin copy from reclaiming the Worker.
- Grok project sessions can be captured via transcript watch on `~/.grok/sessions/**/updates.jsonl` (`platform_source=grok`). Native ACP events omit cwd; the watcher recovers it only from the canonical native `<encoded-workspace>/<UUID>/updates.jsonl` layout, validates the existing directory with realpath, and rejects root, home and the data-directory tree. Saved/header cwd still takes precedence; never substitute the Worker's own cwd.
- The local direct-API observer wrapper is maintained in `scripts/grok-observer` and installed at `~/.claude-mem/bin/grok-observer`. Before token expiry it invokes native `grok models` for silent renewal (no chat session), serializes concurrent renewals, and retries an authentication rejection once. The native CLI owns credential writes; failed renewal leaves credentials and queued work intact. Observer wrappers prepend Homebrew Python to `PATH` so they do not stall on `/usr/bin/python3` when the Xcode license is unsigned. Self-check: `python3 tests/grok-observer-refresh.test.py`.
- Cursor injects cross-source project memory on `sessionStart` and refreshes its generated `.cursor/rules/claude-mem-context.mdc` before prompts. Excluded projects remove only this program's generated rule. OpenCode's system transform requests context by checkout without a source filter; its cache includes both cwd and session ID. Grok's passive hooks do not inject stdout: `scripts/grok-with-memory.mjs`, installed behind the normal `grok` entry, fetches bounded same-project cross-source context and appends it through native `--rules` as untrusted reference. Management/protocol commands and unresolved project scopes pass through unchanged; direct native-binary launches bypass this adapter. Keep the native Grok binary and Cursor's `agent` entry unchanged.
- Knowledge corpora can be read directly with `get_corpus` (newest first, paginated, no additional model/login). The separate Claude `prime_corpus` / `query_corpus` path requires a successful SDK result, not merely a session ID; login failures are errors. Rebuilding refreshes the saved snapshot and clears the old primed session.
- Timeline windows use `(created_at_epoch, id)`, not ID ordering alone: transcript replay and batches can allocate IDs out of timestamp order. Keep the anchor visible even when adjacent IDs have reversed timestamps (`tests/worker/SearchManager.timeline-anchor.test.ts`).
- Local OpenClaw integration is disabled at the user's request (2026-10-10); retain native `memory-core` and existing records/config. The optional `openclaw/` sidecar remains in source, but do not enable it without a new request. If explicitly re-enabled, preserve its local-origin-only search/injection guard and untrusted-history labeling; do not replace native memory or enable cloud/feed access implicitly.
- Compatible official changes through v14.0.1 are ported onto this fork. Schema v67 adds Unicode title-key refresh, work-state sync columns and expanded sync-ledger kinds; the writer stamps `PRAGMA user_version=67`. An old Worker must be stopped before migration; the old 13.35 binary does not enforce this downgrade guard. Schema v51 keeps bounded raw tool I/O separately from the unchanged in-memory queue. `get_observations` exposes linked numeric `tool_use_ids` for `get_tool_uses`; older/unlinked observations return an empty list. Corpus reads are excluded from raw backup to avoid recursive copies.
- Raw tool fields above 64 KiB retain a hash-bound local sidecar in `tool-use-archives` (8 MiB per field, 1 GiB total, owner-only; no automatic deletion). SQLite stays bounded; raw reads restore verified sidecars. Oversize/full/unavailable archives retain an explicit truncation warning. Previously truncated rows are not retroactively recovered.
- Observation TV remains local by default. The remote read-only guard is always mounted and denies remote requests with an empty token, unlike upstream's token-less network bind. Grok Bot awareness is opt-in with an empty agent allowlist. Upstream's personal CCS Align automation and historical pricing datasets are not imported.
- The shipped OpenCode bundle is built from `src/integrations/opencode-plugin/entry.ts`, exporting only the legacy `createV1Hooks` function from `v1.ts` for OpenCode's function-only loader (originally validated on 1.18.35; the installed client is now 1.19.3). That loader walks `Object.values(module)` and rejects non-callable exports; the modern plugin object in `index.ts` and V2 adapter remain source-level support, not the installed entry. Install the matching `dist/opencode-plugin/index.js` at `~/.config/opencode/plugins/claude-mem.js` only after the archive-aware Worker is active; `~/.config/opencode/opencode.json` must list it under `plugin`. Sessions land as `platform_source=opencode`, named after `basename(ctx.directory)` (`ctx.project` has no name and `ctx.worktree` is `/` outside a git repo). `chat.message` posts user turns to `/api/sessions/init` as the prompt — an empty prompt is stored as the `[media prompt]` placeholder — and assistant turns to `/api/sessions/observations`.
- Generator exits that leave buffered work behind (quota, exec timeout, spawn failure) preserve the session and its in-RAM buffer instead of finalizing; the next ingest or `POST /api/sessions/init` (with matching `platformSource`) restarts the generator. Only a clean exit with an empty buffer finalizes. The queue is in-memory only — restarting the worker drops it.
- Upgrade hooks never automatically kill a serving or live owned Worker, even if its version is stale or readiness fails. These cases require authorized manual maintenance after verifying an empty queue; normal cold starts and identity-verified dead-owner ghost cleanup remain available.
- Viewer labels are the host app, not the model. Cursor's Claude Code compatibility layer can replay the same conversation as `hook claude-code`; init/observation ghosts are skipped (`cursor_compat_duplicate`) so one conversation stays a single CURSOR card. Compat-layer Stop summarize is routed onto that CURSOR session because Cursor's own stop hook is often silent. Cursor `session-init` still writes and SSE-broadcasts the PROMPT card (and Chroma-syncs it); it only skips spawning the observer SDK on prompt submit. Real Claude Code sessions stay CLAUDE. SessionStart inject is cross-source and does not pass `platformSource`.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`
- **Codex 用量原始记录**: `~/.claude-mem/usage/codex-usage-YYYY-MM-DD.jsonl`（仅模型、项目、会话 ID 和真实 token 数；保留 90 天）
- **运行日志**: `~/.claude-mem/logs/claude-mem-YYYY-MM-DD.log`（按日切换，自动保留 14 天）

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
