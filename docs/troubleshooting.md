# 故障排查

| 状态 | 含义 | 处理方式 |
|---|---|---|
| `MISSING_RUNTIME` | Node.js 版本低于 18 或不可用 | 安装 Node.js 18+，重开任务后重试 |
| `INVALID_INSTALLATION` | Skill 文件缺失或包名错误 | 重新从 GitHub 的 `skills/codex-bridge-chatgpt` 路径安装 |
| `NEEDS_AUTOMATION_CONSENT` | 没有有效的全自动桥接风险决策 | 阅读完整风险说明，明确启用或拒绝 |
| `AUTOMATION_DISABLED` | 用户已经拒绝或撤销全自动桥接 | 保持本地执行；需要时重新完成明确授权 |
| `NEEDS_DESKTOP_APP` | 当前不是支持的桌面 App Codex 环境 | 改用 Mac/Windows ChatGPT 桌面 App |
| `NEEDS_BROWSER` | 内置 Browser 或 Browser Skill 不可用 | 更新桌面 App，确认 Browser 能力启用 |
| `NEEDS_CHATGPT_LOGIN` | 内置 Browser 中的 ChatGPT 未登录 | 接管页面完成登录，然后回复“已登录” |
| `NEEDS_MODEL_SELECTION` | 请求模型不可见或未选中 | 在页面选择模型；如需降级，明确批准目标模型 |
| `NEEDS_SITE_PERMISSION` | ChatGPT 站点访问等待授权 | 在桌面 App 中允许访问 `chatgpt.com` |
| `SCOPE_MISMATCH` | 请求、结果、Chat 或工作区不属于当前会话作用域 | 读取状态并核对绑定；需要换 Chat 时走预览/应用迁移 |
| `MIGRATION_REQUIRED` | 旧状态或损坏状态不能安全推进 | 先检查备份与 journal，再显式运行状态迁移或恢复 |
| `SETUP_CONFLICT` | setup 计划、项目配置或同名 MCP 表发生变化 | 重新生成计划并检查冲突，不覆盖未受管配置 |

## 普通 Chrome 已登录但仍要求登录

正常。内置 Browser 使用独立配置，不自动共享普通 Chrome 的 Cookie。V1 不会切换到普通 Chrome 绕过预检。

## Result 格式校验失败

App 级 Chat 协调允许把校验错误发回同一 Chat 修复一次；第二次仍无效就中止当前轮次。可见 Browser 后备路径保持一次发送和一次复制，结果无效时直接中止，不自动重试。

App 级发送返回成功只表示请求已进入队列。真实联调中，消息可能约一分钟后才出现在普通 Chat。用 `read_thread` 按轮次幂等键轮询，直到同一 turn 的回答完成；第一次读取为空时不要重复发送。`wait_threads` 面向 Codex 任务，不能假定它支持普通 ChatGPT 会话。

## 提示 `bootstrap_chat_protocol`

新绑定或迁移后的 Chat 还没有确认当前紧凑协议。把 `references/protocol-bootstrap.md` 的协议说明发送到该 Chat 一次，收到 `ACK-BRIDGE-PROTOCOL compact-v1` 后运行 `context-state.mjs protocol-ready`。不要跳过确认，也不要每轮重复发送协议全文。

## `resume` 之后仍在等待

`resume` 只恢复对固定 Chat 的读取轮询，绝不会重发请求。先用 `npm run bridge -- status` 查看送达子状态，再用 `inspect` 检查当前轮次。如果有界轮询仍无法区分未送达与回答尚未完成，保持 `RECOVERY_REQUIRED` 或明确中止该轮。

## Token 数字与 ChatGPT 显示不一致

`cost` 使用本地启发式估算，适合比较轮次、重复率和协议占比，不是账单或服务端 tokenizer。无效但已返回的 `result-invalid-*.json` 会单列为浪费的回答 Token。`avoided_history_tokens` 表示因为复用同一 Chat 而无需重传的历史估计量，不能解释为套餐额度退款。

## 请求超过 3,000 Token 或字段条目上限

先运行 `bridge optimize` 查看重复率和可自动移除的空字段。压缩器不会静默截掉唯一证据；某个字段超出条目上限时，应由 Codex 按决策相关性筛选，或把任务拆成多轮。低层 `prepare` 同样执行 3,000 approximate-token 硬上限。

## 为什么没有复用上次结果

结果复用要求语义请求、工作区指纹和输入 checkpoint 哈希同时相同，并且最近一轮已经完整通过本地闸门。文件、分支、未提交状态、checkpoint 或问题发生任何变化时，`start` 都会创建新轮次。需要独立第二意见时，在 spec 中设置 `allow_reuse: false`。

## 找不到原来的 Chat

不要静默创建新 Chat。先校验本地 checkpoint 和最近一次完成的交换，再由用户选择替代的普通 ChatGPT Chat。新 Chat 回显 bridge ID、会话作用域、轮次和持久决策后，先生成 `preview-chat-migration`，检查目标摘要和有效期，再用 `apply-chat-migration` 应用同一份计划。计划生成后状态、checkpoint、工作区或目标发生变化都会拒绝执行。

## 状态需要升级

Schema v1 或 v2 状态不会在后台静默改写。运行 `context-state.mjs migrate-state --workspace <root>` 后，工具会先保存并复核旧状态的精确备份，再记录迁移来源并原子发布 schema v3。失败时保留原状态并返回 `MIGRATION_REQUIRED`。

## 状态轮询重复返回大量内容

保存上次响应里的 `state_revision`，下一次 MCP `bridge_status` 或 `bridge_health` 传入 `since_revision`。修订号未变化时只返回状态、修订号和 `unchanged: true`。

## 有未完成轮次

`context-state.mjs begin` 会拒绝并发轮次。先确认前一轮是否可靠完成；结果不确定时使用 `abort --reason <原因>` 保留事件记录，再开启下一轮。不要复用已经中止的轮次号。

## `BRIDGE_BUSY`

另一个本地进程正在提交桥接状态。使用 MCP `bridge_lease_status` 查看操作名称，等待它结束后重新读取状态。不要手工删除仍有心跳或进程仍存活的租约。进程已经退出且心跳超时后，下一次写入会原子回收陈旧租约。

## `STATE_CONFLICT`

当前操作读取状态后，另一个进程已经完成更新。重新运行 `status`，确认轮次和送达状态，再决定是否重复本地操作。这个错误不允许重新发送不确定的 Chat 请求。

## 回答可见但复制结果无法验证

页面上可见的 JSON 不能代替成功的“复制回复”。不要把手工重建的页面内容算作已验证 Result，也不要再次发送原请求。若最近一轮已经被误标为完成，先用 `invalidate-completed` 提供当前状态修订号、相同运行目录中上一份可信 checkpoint 的路径和 SHA-256。工具会保留审计记录、撤销该轮采纳、恢复上一份 checkpoint 并暂停桥接，待明确核对传输后再恢复。

## MCP 服务未出现

确认项目已被 Codex 信任，`.codex/config.toml` 的 `cwd` 指向项目根目录，脚本使用绝对包路径，并在修改配置后重启客户端。优先用 `npm run setup -- --workspace . --output bridge-setup-plan.json` 预览，再用 `npm run setup -- --apply bridge-setup-plan.json` 应用。也可参考 `docs/codex-mcp-config.example.toml`。MCP 服务只使用 STDIO，不需要端口或 OAuth。

## 模型名称无法证明

只有当前运行中可见的模型 UI 才能记录为 `verified`。回答中的模型自述、Packet 的 `requested_reasoner` 和历史截图都不能替代当前证据。

## 页面结构变化

如果登录、模型选择器、复制按钮或回答标题无法可靠识别，Skill 应明确失败并保留本地任务，不静默报告传输成功。

如果发送后无法确认是否已经提交，或点击“复制回答”后剪贴板没有变化，Skill 不会再次发送，也不会通过 DOM 抽取回答。它会保留本地任务并报告明确阻塞。
