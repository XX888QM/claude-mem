# claude-mem 13.31.1 fork upgrade implementation plan

> **For agentic workers:** Use native execution in this session. Do not delegate implementation or commit/push. Ordinary and final Daybreak reviews remain required.

**Goal:** Bring compatible official 13.31.1 changes into the current working tree without losing its committed or uncommitted customizations, then verify the installed runtime.

**Architecture:** Three-way port from official v13.28.0 to v13.31.1 against the actual local files. Resolve source conflicts individually and regenerate bundles from the resulting source. Preserve local-only integration and credential boundaries.

**Tech stack:** Bun, TypeScript, Node.js, SQLite, local Chroma, existing build/test commands.

**Spec:** Current user request in this chat: merge the official upgrade with our existing modifications. Scope excludes commit, push, remote deployments, model changes and re-creating the deleted automation.

## Global constraints

- Original HEAD: `05962814db02f7bf3a5aaf04d9feba484128fd9c`; official target: `59c657355d5f42fad45aafb5685ff462d608fe0b` (`v13.31.1`).
- Backup: `/Users/yunxin/.claude-mem/upgrade-backup-20261006-46y8zy` (dirty files, Git metadata, immutable official base/target snapshots).
- Keep Grok/Codex providers, Claude-quota refusal, source attribution, raw I/O scoping, buffered work preservation, direct corpus reads, timestamp-based timeline windows and local-only OpenClaw memory integration.
- Never blanket-select ours/theirs. Do not import upstream personal pricing datasets or auto-enable optional integrations/cloud sync.
- Runtime restart requires explicit consent and an empty in-memory queue; preserve settings and old installed files for rollback.

## Review focus

1. Provider routing must not spend Claude quota or silently change Grok/model/summary tiers.
2. Shutdown must not discard buffered work; semantic queries must keep the restored Chroma index and original database.
3. Project/platform boundaries and raw-data read-only guards must survive upstream HTTP/filter changes.
4. OpenClaw must coexist with memory-core and retain encoded, lower-priority, local-only history and the existing owner-only channel boundary.
5. UTF-8 paths, summary-only history, timeline anchors and cached settings must retain their regression coverage.

## Tasks

- [x] Record current health/readiness, dirty files and original HEAD; back up without resetting/stashing user changes.
- [x] Fetch and archive the exact official target and review its source/dependency delta.
- [x] Port compatible source, manifests, tests and supporting files; inspect conflicting source hunks and regenerate launcher strings.
- [x] Resolve overlapping provider/queue/hook/context/Claw customizations. Existing CLAUDE.md safety requirements remain valid.
- [ ] Run `npm run typecheck`; run changed-area tests plus the retained local regressions. Classify existing failures separately.
- [ ] Build via `npm run build`, not hand edits to generated bundles; verify UI changes from a running application if applicable.
- [ ] Obtain ordinary code review (Python reviewer if Python source changes) and final Daybreak review on the authorized diff and required call chains.
- [ ] With restart consent, back up installed artifacts, synchronize the marketplace, Claude/Codex caches and applicable existing integrations, then wait for queue drain and restart.
- [ ] Read back successor PID/version 13.31.1, readiness/MCP, provider/quota settings, semantic search, corpus read, timeline and Claw integration.
- [ ] Inspect final Git status and pending commits; deliver verified results and any unresolved boundaries without committing or pushing.

## Progress evidence and boundaries (12:30 local)

- Three-way port applied 988 clean files; resolved source conflicts individually. Kept local Codex exec provider rather than replacing it with official app-server, and kept deleted cowork/ccs-align excluded. Cost-report and pricing datasets remain excluded; no Python changes.
- Root/viewer typecheck passed. Full build passed after regenerating canonical shell templates; subsequent source fixes require a final rebuild.
- Ordinary Astra reviews found five upgrade regressions: paid-send budgeting, parked summary collapse, overflow cooldown, cross-source semantic injection and Grok effort validation. All received failing tests and fixes, and focused reviewer rechecks passed. Codex reasoning UI omission was also restored.
- Independent tests: OpenClaw 49/49; CLI fake binaries and existing CLI suite 25/25; data/timeline/watermark/bootstrap/revision 58/58; Claude feed pacing 24/24; quota/corpus/failed SDK result 5/5. Tests never used real Claude quota.
- Broad first run: 7427 pass, 36 skip, 225 fail, 8 errors across 753 files, 573 seconds. This was taken during implementation and is NOT final passing evidence. Many failures reflect official app-server expectations absent from this fork, old iterator mocks, cross-source-default fixtures and process-global mocks. Known affected tests are being adapted and independently rerun; no blanket pass claim.
- Original Chroma runOperation mutation-serialization bypass predates this upgrade. It was not silently expanded into a repair; keep it as a pre-existing risk.
- Unexpected native-hook activation: package version became 13.31.1 before rebuilding. Existing version-mismatch hooks killed old workers at 11:59:35 and 12:07:44 and selected source Worker PID 25302. Last preceding enqueue depths were 2 and 8, so queue-loss-free activation is NOT proven. No manual restart command has been issued. Source worker 25302 is an intermediate build, not the final code; its env still points at the 13.28.0 Codex cache for assets.
- Grok reported a session limit at 12:09:49 and the generic provider breaker pauses it until roughly 12:39:49. RAM backlog exceeded 100 at 12:24. User approved Worker restart only after queue drain; no final restart, model swap or queue clear is authorized while this remains pending.
- Current SQLite consistent backup saved as backup/database-current.db after the automatic intermediate activation, not a pre-migration database snapshot. Current database quick_check returned ok; observations=139511, summaries=9375, schema=64. Chroma embeddings=524783. Corpus reads remain available; none were rebuilt or deleted.
- Daybreak actual prompt-only calls are in progress for three diff/call-chain groups. Materials/status/results are /tmp/claude-mem-upgrade-security-{a,b,c}*. Do not infer passed until TURN_STATUS=completed and results are read.
- Gateway restart consent was requested asynchronously because after_tool_call activates only when its plugin reloads; Worker consent alone does not authorize Gateway restart.

## Final-source checkpoint (13:05 local; not completion)

- User confirmed Worker restart ONLY after the queue clears. No manual restart, model switch, queue deletion, commit or push was performed. The last queue check showed 164 and remains blocked on Grok quota; the loaded Worker is still the intermediate PID 25302, not this final rebuilt source.
- First Daybreak groups A/B/C completed but did not pass. Confirmed active upgrade issues were repaired: trusted mode metadata only enters HTTP system messages; tool XML data is escaped and batch wrappers are built structurally; foreign browser writes are centrally refused; Claude send and fallback paths honor the quota guard. The policy now strictly reads valid settings and fails closed on missing/corrupt/unspecified settings, preserving the existing explicit environment test override.
- New disk spool uses owner-only directory/file modes and configured pre-disk redaction without changing advisor routing/dedupe IDs. Non-human health/fallback context no longer includes provider error prose/action. Cache identity hashes the project array, not a comma-joined string. Token read failure refuses destructive reclaim; automatic version recycle verifies an empty queue and rechecks its deadline before killing.
- Restore the fork's exact project identity throughout SessionStart, SQL reads, raw pagination, MCP checkout alias expansion, Claude.md reads and work-state grouping. Explicit aliases and merged worktrees remain; add BINARY recency indexes without removing older indexes or rewriting records. This deliberately excludes upstream implicit case-fold merging.
- Fresh root/viewer typecheck and source-generated build passed. Latest relevant sets: 45 prompt/write/quota/spool/checkout tests, 19 project/query/work-state tests, 27 provider/budget/buffer tests, all passed. Earlier lifecycle/health 122 and context/cache/prompt/spool 157 passed. Ordinary Astra reviews of the final affected fixes approved; their old-expectation test follow-ups were updated and rechecked.
- Isolated rerun of the original 66 failing test files yielded 30 passing / 36 still failing before the last safety compatibility test changes. Remaining failures are NOT all dismissed: official app-server contracts differ from this fork, several ingest/manager mocks need adaptation, and other failures still need classification. Broad test acceptance remains incomplete.
- Final Daybreak rechecks: `/tmp/claude-mem-upgrade-security-recheck-{result.txt,status.log}` covers affected fixes; `/tmp/claude-mem-project-quota-security-final-{result.txt,status.log}` supplies the later complete strict-project/quota changes. Results must be read before any security-pass claim. No current whole-upgrade security approval.
- Unconfigured optional cloud paths still have reviewed transaction/Chroma, hub-quarantine and WebSocket risks; optional zstd decoding still lacks output caps. Spool retention is nondestructive and has no total storage ceiling. Existing cwd launcher trust risk remains. None of these optional services was enabled, and they are not declared safe.
- Current SQLite quick_check remains `ok`. Installed cache synchronization, final runtime activation, actual final UI walkthrough and final Claw plugin activation remain undone. Active assets still come from the old Codex cache. No corpus topic rebuild or original-record deletion.
- Git source status: 513 tracked changed, 505 untracked, zero staged; original 47 pending commits remain. Own origin is unchanged. Source diff check passes; generated dependency bundles contain build-produced trailing whitespace, not manually patched.

## Later checkpoint (14:00 local; still not completion)

- Source now refuses all automatic replacement of a serving/live owned Worker. Failed readiness, stale version and repeated silence return maintenance fallback; cold starts and identity-checked dead-owner ghost cleanup remain. This supersedes the earlier queue-snapshot recycle description. CLAUDE.md documents the changed contract.
- Final focused sets passed: 112 lifecycle/redaction/cache tests, 28 ready-stream/unhealthy-port tests and 41 provider/quota/project regression tests. Fresh typecheck and source-generated build passed. These do not clear the earlier broad test failures.
- Ordinary final affected implementation review approved. Actual Daybreak four-fix recheck completed but did NOT pass: Windows dead-owner descendant targets still lack installation ownership proof; legacy wide-permission cache files are not tightened on reads. Windows ACL and the final manual restart call chain also lack acceptance evidence. Result: /tmp/claude-mem-four-fixes-review-result.txt.
- Latest queue read: 96, parked sessions 0; loaded Worker remains PID 25302. No manual restart, installed-cache synchronization, final UI/Gateway activation, model change, commit or push occurred. Original 47 pending commits remain; zero staged. Final safety/runtime acceptance remains open in work-state.
