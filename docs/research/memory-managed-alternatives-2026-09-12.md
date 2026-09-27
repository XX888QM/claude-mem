# 托管/跨工具记忆替代品核实（2026-09-12）

范围：Mem0（含 OpenMemory）与 Supermemory；只依据项目官方文档/官方 GitHub 原始仓库，未安装、未登录、未上传本机记忆。以下是“官方声称的能力”，不是本地实测；两家宣传的 benchmark 数字也没有在本轮独立复现。

## 结论

对 Claude Code + Codex + Cursor + Grok 的现有组合，Supermemory 是更接近“装上后自动记忆”的托管候选：官方提供 Claude Code、Cursor、Codex 插件，均有 hook 做自动 recall/capture；但云端 API/账号仍是依赖，OAuth/API-key 失效仍属于外部服务故障面。若最看重数据留在 Mac，Supermemory Local 的方向比 OpenMemory 合适，但其与四个客户端的现成自动 hook/MCP 组合、Grok 支持和长期运行稳定性仍需本机验收。

Mem0 的 Claude Code 插件自动化程度也够用，但当前官方实现明确要求 Mem0 Platform API key，并且这条插件路径不是本地 Mem0；Mem0 的 OpenMemory 项目主要是跨 coding harness 的会话导入/导出 CLI/TUI，不是 claude-mem 式的实时观察器。

## Mem0

### 自动捕获与客户端覆盖

- 官方 Claude Code 插件说明：hooks 本地捕获 user message、回答、改动路径和简短测试结果；后台 worker 每五次完成交互、session end/compact 或 idle flush 时发送到 Mem0；下一会话首个足够长的 prompt 自动搜索并注入相关记忆。见 [Mem0 Claude Code plugin README](https://raw.githubusercontent.com/mem0ai/mem0/main/integrations/claude-code-plugin/README.md)（“How it works”）。
- 该插件不是纯手动 MCP：README 明说“Memory is captured and recalled automatically”；显式搜索只是补充。捕获阶段本身不调用模型，但 flush 的 `add` 由 Mem0 提取记忆。
- Mem0 主仓库当前包含 `.claude-plugin`、`.codex-plugin`、`.cursor-plugin` 目录，说明官方在做这些客户端入口；但本轮未找到可直接读取的 Cursor/Codex README，因此不能把“目录存在”扩大成已验证的四端自动捕获。见 [Mem0 repository](https://github.com/mem0ai/mem0/tree/main)。

### 云、本地、费用与模型依赖

- Claude Code 插件前置条件写死为 Mem0 Platform API key（`m0-`），并把 key 用于创建/搜索记忆；因此这条集成至少依赖 Mem0 云服务和 API 认证。见 [plugin README prerequisites](https://raw.githubusercontent.com/mem0ai/mem0/main/integrations/claude-code-plugin/README.md#L7-L21)。本轮不据此断言具体免费额度或价格。
- Mem0 主仓库把 Library、Self-Hosted Server、Cloud Platform 分开：Library 适合测试/原型，Self-Hosted 适合自运维团队，Cloud 适合零运维生产；自托管不是 Claude Code 插件 README 的默认路径。见 [Mem0 README](https://github.com/mem0ai/mem0#quickstart-guide)。
- Mem0 官方 README 的新算法说明称托管平台使用了开源 SDK 没有的 proprietary optimizations，并提醒开源结果不会完全相同；因此不要把仓库 benchmark 表当成这台 Mac 或自托管部署的实测结果。见 [Mem0 benchmark note](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026)。

### OpenMemory 的真实定位与成熟度

- OpenMemory 官方定位是“Open-source CLI & TUI to port AI coding sessions”，当前支持 Claude Code、Codex、OpenCode；用 `openmemory port --from <src> --to <dest>` 选择性导入/导出会话。它解决“换 harness 搬历史”，不是监听每轮对话并自动提取长期记忆。见 [OpenMemory README](https://github.com/mem0ai/openmemory#sync-your-sessions-across-any-coding-harness)。
- 官方 roadmap 把 realtime `autosync` 标成“coming soon”，所以不能把它当成已交付的自动同步方案。该仓库页面当前展示约 34 stars、5 forks；这只能说明项目体量，不等于质量结论。见 [OpenMemory roadmap](https://github.com/mem0ai/openmemory#roadmap)。

## Supermemory

### 自动捕获与客户端覆盖

- 官方 Claude Code 插件：session end 自动保存 conversation；每轮前由插件决定是否 recall，支持 `/supermemory:*` 命令。需要 Node.js 18+ 和 `SUPERMEMORY_CC_API_KEY`。见 [claude-supermemory README](https://raw.githubusercontent.com/supermemoryai/claude-supermemory/main/README.md#features)。
- 官方 Cursor 插件：会话开始加载 profile，对实质 prompt 自动 recall，保存每个完成 turn，并在 session end 重试未保存 transcript；MCP 工具用于显式控制。见 [cursor-supermemory README](https://raw.githubusercontent.com/supermemoryai/cursor-supermemory/main/README.md#what-it-does)。
- 官方 Codex 插件：`UserPromptSubmit` 自动 recall、`Stop` 后台 capture、`SessionStart` 加载 profile；较深的 search/add/list/forget 走托管 MCP。安装器会写 `~/.codex/config.toml` 和 `~/.codex/hooks.json`。见 [codex-supermemory README](https://raw.githubusercontent.com/supermemoryai/codex-supermemory/main/README.md#how-it-works)。
- 官方总仓库列出 Claude Code、Cursor、Codex、OpenCode 等插件，并明确 MCP URL 为 `https://mcp.supermemory.ai/mcp`；但“支持 Grok”在本轮官方资料中未找到，不能假定 Grok bot 可直接接入。见 [Supermemory repository integrations](https://github.com/supermemoryai/supermemory#supermemory-plugins)。

### 云、本地、费用与模型依赖

- 云端插件需要 Supermemory API key；Codex 也支持首次 prompt 浏览器认证，hooks 直接调用 API，模型发起的深层操作走 hosted MCP。也就是说自动化不是手动点 MCP，但仍依赖云端认证/网络。见 [Codex plugin authentication](https://raw.githubusercontent.com/supermemoryai/codex-supermemory/main/README.md#quick-start)。本轮不据此断言具体价格或免费额度。
- 官方 Supermemory Local 提供 Mac 可运行的单二进制/`npx supermemory local`，首次启动建立 embedded graph engine 和 local embeddings，API 在 `http://localhost:6767`；README 声称可带任意模型或用 Ollama 完全离线。见 [Supermemory Local](https://github.com/supermemoryai/supermemory#supermemory-local--run-it-yourself)。这是产品声明，未在本机启动验证。
- Supermemory 公开仓库同时包含云 API、插件、MCP 和 Local 路径；因此要达到“本地数据 + 四端自动观察”，不能只把 hosted MCP URL 改成本地地址就视为完成，仍需验证各插件是否支持该 base URL、hook 行为和 Grok 入口。

### 维护与风险边界

- Supermemory 的 MCP v1 仓库 README 已提示 MCP v1 正在弃用，代码维护迁往主仓库 `apps/mcp`；新部署不应复制旧 v1 配置。见 [supermemory-mcp README](https://github.com/supermemoryai/supermemory-mcp#supermemory-mcp---universal-memory-across-llms)。
- 官方仓库的 issue 曾记录“写入成功但 recall/search 为空”的认证/容器隔离问题（该 issue 已关闭，但它说明升级、旧账户和 container tag 仍是需要验收的边界）。见 [Supermemory issue #792](https://github.com/supermemoryai/supermemory/issues/792)。这不是本轮确认当前仍有该故障。

## 给当前项目的短建议

1. 只想减少 OAuth 过期带来的“观察器不落库”：优先把 Supermemory 的 Claude Code/Codex/Cursor hooks 当候选，先做小规模本机 smoke test；Grok 要单独确认，没有官方四端+Grok 一体化证据。
2. 想跨 Claude Code/Codex 搬历史：OpenMemory 值得看，但按“导入/导出工具”评估，不按实时记忆服务评估。
3. 想完全本地：比较 Supermemory Local 与现有 claude-mem 本地 SQLite/worker 的实际维护成本；Mem0 Claude Code 插件的官方默认路径仍是 Platform API key + 云服务。

