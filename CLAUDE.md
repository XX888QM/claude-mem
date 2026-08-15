# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

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

## Local Runtime Overrides

- Observer SDK subprocesses use `~/.claude-mem/observer-claude-config` as their private `CLAUDE_CONFIG_DIR` so internal sessions do not appear in CC Switch.
- `CLAUDE_MEM_PROVIDER=codex` runs observation and summary work through the logged-in Codex CLI. It does not automatically fall back to Claude; quota failures retain queued work and apply a five-minute retry cooldown. On macOS, daemon installs prefer the regular PATH/npm Codex CLI, then use the `ChatGPT.app` bundle as a last-resort fallback because some daemon contexts report `ENOENT` for the bundled executable.
- Codex defaults are `CLAUDE_MEM_CODEX_MODEL=gpt-5.6-luna` and `CLAUDE_MEM_CODEX_REASONING_EFFORT=medium`. Each call is ephemeral, read-only, approval-free, runs below `~/.claude-mem/observer-sessions` so recursive claude-mem hooks are filtered even when the CLI strips environment flags, skips the empty init call, and is capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`.
- When `CLAUDE_MEM_SUMMARY_PROVIDER=codex` (or `grok`), summary batches use `CLAUDE_MEM_SUMMARY_MODEL` and `CLAUDE_MEM_SUMMARY_EFFORT` via each provider's `getSummaryConfig` override; observation batches continue to use the regular provider model and effort settings.
- `CLAUDE_MEM_PROVIDER=grok` runs observation and summary work through the logged-in Grok CLI (`grok --prompt-file`, membership/session auth). Defaults: `CLAUDE_MEM_GROK_MODEL=grok-4.5`, `CLAUDE_MEM_GROK_REASONING_EFFORT=medium` (the CLI accepts only `low`/`medium`/`high`; anything else normalizes to `medium` because the CLI exits 1 on unknown effort levels). Stateless single-shot mode: **skips the huge init skeleton LLM call**, sends only the latest observation/summary task with a short protocol system prompt (prompt clipped to ~24k chars), `--tools "" --max-turns 5 --no-memory`, `GROK_HOME=~/.claude-mem/observer-grok-home` (auth symlinked from real `~/.grok`), and an ephemeral cwd below `~/.claude-mem/observer-sessions`. Concurrency capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` with query-time cooldown checks. Format salvage rewrites observation-shaped `<summary>` into protocol summary fields. Transcript watcher skips legacy ephemeral `/var/folders` / `claude-mem-grok-*` session paths to avoid ENOENT spam.
- Codex hooks resolve the local Codex cache (`~/.codex/plugins/cache/claude-mem-local/claude-mem`) before Claude's cache and the marketplace, preventing an older Claude plugin copy from reclaiming the Worker.
- Grok project sessions can be captured via transcript watch on `~/.grok/sessions/**/updates.jsonl` (`platform_source=grok`).
- The OpenCode plugin bundle is built from `src/integrations/opencode-plugin/entry.ts`, which re-exports only the plugin function. OpenCode's loader walks `Object.values(module)` and throws `TypeError("Plugin export is not a function")` on the first non-callable export, so building from `index.ts` (which also exports const arrays for the contract test) silently disables the whole plugin. Install with `cp dist/opencode-plugin/index.js ~/.config/opencode/plugins/claude-mem.js`; `~/.config/opencode/opencode.json` must list it under `plugin`. Sessions land as `platform_source=opencode`, named after `basename(ctx.directory)` (`ctx.project` has no name and `ctx.worktree` is `/` outside a git repo). `chat.message` posts user turns to `/api/sessions/init` as the prompt — an empty prompt is stored as the `[media prompt]` placeholder — and assistant turns to `/api/sessions/observations`.
- Generator exits that leave buffered work behind (quota, exec timeout, spawn failure) preserve the session and its in-RAM buffer instead of finalizing; the next ingest or `POST /api/sessions/init` (with matching `platformSource`) restarts the generator. Only a clean exit with an empty buffer finalizes. The queue is in-memory only — restarting the worker drops it.

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
