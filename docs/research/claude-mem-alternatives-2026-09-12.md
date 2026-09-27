# claude-mem 替代项目初筛（2026-09-12）

仅核对官方文档、仓库和 GitHub API，未安装、迁移或实测；不是性能排行榜。评估重点是 Claude Code / Codex / Cursor / Grok 跨工具使用、中文检索、避免独立提炼模型的登录与维护负担。

## 结论

没有证据说明某个项目全面胜过当前本地定制版。若首要目标是减少后台服务与独立模型调用，优先小范围评估 Gentleman-Programming/engram；若重点是长期、可人工编辑的知识库，优先 Basic Memory；若重点是找回原始聊天历史，CASS 更接近检索补充而非完整记忆替代。以上是基于架构的判断，稳定性与中文效果需要本机样本验证。

## 官方资料与取舍

- **Engram（Gentleman-Programming，不是其他同名仓库）**：Go 单程序，SQLite + FTS5；提供 Claude Code、Codex、Cursor 等集成。记忆主要由当前工作中的 AI 选择并保存，避免独立后台 AI 压缩链路，但不能把“有记忆协议”理解为保证全量自动捕获。[仓库](https://github.com/Gentleman-Programming/engram)、[接入文档](https://github.com/Gentleman-Programming/engram/blob/main/docs/AGENT-SETUP.md)、[设计比较](https://github.com/Gentleman-Programming/engram/blob/main/docs/COMPARISON.md)。比较页对 claude-mem 的“只支持 Claude”等描述已不适用于当前版本，不采信其竞品描述。
- **中文风险核对**：Engram 的 [CJK 问题 #140](https://github.com/Gentleman-Programming/engram/issues/140) 曾报告分词失败。本次实时 GitHub API 确认问题已关闭，维护者留言表示 main 已解决；相关 PR #537 未合并，不能仅据该 PR 判断修复状态。未确认当前安装包的中文实际效果。
- **Basic Memory**：知识以 Markdown 保存，人和 AI 均可编辑；提供本地部署、MCP、多客户端及可选云服务。Codex 插件区分“生命周期事件归档”和“AI 写出的知识笔记”，不能把事件捕获直接当成知识入库。[README](https://github.com/basicmachines-co/basic-memory/blob/main/README.md)、[Codex 插件](https://github.com/basicmachines-co/basic-memory/blob/main/plugins/codex/README.md)。适合长期知识资产；不是 claude-mem 全量工具事件提炼的原样替换。
- **CASS**：统一索引本地多种 AI 工具会话；官方文档列出 Claude、Codex、Cursor 和 Grok Build，支持关键词及可选语义检索。主要产品是历史搜索 CLI/TUI，不应当作自动知识总结与注入的完整替代。[仓库](https://github.com/Dicklesworthstone/coding_agent_session_search)、[发布记录](https://github.com/Dicklesworthstone/coding_agent_session_search/releases)。全量聊天索引仍涉及敏感数据，搜索输出脱敏不等于磁盘加密。

没有上传用户历史数据，也未修改现有插件、模型或登录配置。厂商自测分数、Star 数不作为“更准确/更稳定”的证明。
