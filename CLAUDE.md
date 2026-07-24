# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Local Runtime Overrides

- Observer SDK subprocesses use `~/.claude-mem/observer-claude-config` as their private `CLAUDE_CONFIG_DIR` so internal sessions do not appear in CC Switch.
- `CLAUDE_MEM_PROVIDER=codex` runs observation and summary work through the logged-in Codex CLI. It does not automatically fall back to Claude; quota failures retain queued work and apply a five-minute retry cooldown.
- Codex defaults are `CLAUDE_MEM_CODEX_MODEL=gpt-5.6-luna` and `CLAUDE_MEM_CODEX_REASONING_EFFORT=medium`. Each call is ephemeral, read-only, approval-free, runs below `~/.claude-mem/observer-sessions` so recursive claude-mem hooks are filtered even when the CLI strips environment flags, skips the empty init call, and is capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS`.
- When `CLAUDE_MEM_SUMMARY_PROVIDER=codex` (or `grok`), summary batches use `CLAUDE_MEM_SUMMARY_MODEL` and `CLAUDE_MEM_SUMMARY_EFFORT` via each provider's `getSummaryConfig` override; observation batches continue to use the regular provider model and effort settings.
- `CLAUDE_MEM_PROVIDER=grok` runs observation and summary work through the logged-in Grok CLI (`grok --prompt-file`, membership/session auth). Defaults: `CLAUDE_MEM_GROK_MODEL=grok-4.5`, `CLAUDE_MEM_GROK_REASONING_EFFORT=medium`. Stateless single-shot mode: **skips the huge init skeleton LLM call**, sends only the latest observation/summary task with a short protocol system prompt (prompt clipped to ~24k chars), `--tools "" --max-turns 5 --no-memory`, `GROK_HOME=~/.claude-mem/observer-grok-home` (auth symlinked from real `~/.grok`), and an ephemeral cwd below `~/.claude-mem/observer-sessions`. Concurrency capped by `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` with query-time cooldown checks. Format salvage rewrites observation-shaped `<summary>` into protocol summary fields. Transcript watcher skips legacy ephemeral `/var/folders` / `claude-mem-grok-*` session paths to avoid ENOENT spam.
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
