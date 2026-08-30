BEGIN_CONTEXT_PACKET
packet_id: architecture-2026-08-30-1k
requested_reasoner: GPT-5.6 Sol (required for account-level acceptance; anonymous run is transport-only)

## Objective
审查 `chatgpt-reasoning-handoff` Skill 的最小架构是否真正实现以下职责分离：Codex/Luna 只负责读取本地项目、搜索、压缩上下文、调用浏览器、核对方案、修改和测试；ChatGPT 网页端只负责复杂推理并返回结构化建议。需要判断当前实现是否存在让网页模型越权、让本地模型盲从、泄露项目内容或伪造模型身份的缺口，并提出最小修正。

## Acceptance
- 普通复杂任务产生约 1000–3000 tokens 的 Context Packet；任务本身足够小时允许更短，但不得超过 3000 approximate tokens。
- Packet 与 Result 都有稳定边界标记、固定章节和相同 `packet_id`，能由无第三方依赖的本地脚本验证。
- 网页输出不被视为仓库事实。Codex 必须重新打开涉及的文件、符号和测试入口，再决定是否采纳。
- 浏览器必须使用用户指定的 Codex 内置浏览器。未登录、模型选择器不可见或目标模型不可用时，不得声称使用了 GPT-5.6 Sol。
- 账号只能使用页面实际开放的功能；Skill 不实现套餐、权限、登录或安全策略绕过。
- 最终回执分别报告 Packet、浏览器传输、模型验证、Result 校验、本地修改和测试状态，不能以局部成功代替完整成功。

## Repository State
- 目标目录：`<local-workspace>/chatgpt-reasoning-handoff`。
- 这是一个新的独立 Skill 源目录，没有初始化 Git 仓库，没有 commit、push、全局安装或公开发布。
- 目录包含 `AGENTS.md`、`SKILL.md`、两个按需引用文档、一个 Node 校验器、测试与浏览器实测产物。
- 本轮没有修改用户现有 `commit_note` 工作树，也没有读取或传输其中的文章、浏览记录、账号信息或私有笔记。

## Evidence
- `AGENTS.md` 规定本地仓库内容默认按私有信息处理；禁止把凭据、Token、私钥、个人数据、原始环境文件和无关代码放进网页 Prompt；ChatGPT 只提方案，Codex 负责验证、修改和测试。
- `SKILL.md` 的触发条件限定为需要高成本架构、调试或权衡推理的仓库任务；机械修改、简单查询和已经确定的方案留在本地执行，避免为所有任务支付浏览器往返成本。
- 本地搜集顺序是先读仓库规则和 `git status`；存在 `.codegraph/` 时优先 CodeGraph，否则使用 `rg`。它要求只收集会改变决策的证据，不读取整个仓库后原样发送。
- `references/context-packet.md` 固定 Objective、Acceptance、Repository State、Evidence、Constraints、Questions 六个章节。目标、验收、决定性证据和约束优先，历史背景与不会改变决策的实现细节被删除。
- `references/reasoning-request.md` 要求网页模型声明没有仓库访问权，把证据和推断分开，把无法确认的事实放进 Unknowns，并按 Verdict、Assumptions、Evidence Used、Proposed Changes、Tests、Risks、Unknowns 七个章节返回。
- `scripts/validate-handoff.mjs` 使用 Node 标准库。它检查边界标记、章节顺序、`packet_id`、`requested_reasoner`、3000 approximate-token 上限和常见凭据形态；`pair` 模式比较发送与回传的 `packet_id`。
- approximate token 估算对中日韩字符按一个字符一个 token，对其余字符按四字符一个 token。该算法是无依赖安全上限近似，不是 OpenAI 官方 tokenizer，因此回执只能写 approximate tokens。
- 测试覆盖：完整 Packet 通过、常见密钥被拒绝、超长 Packet 被拒绝、完整 Result 通过、缺少 Risks 被拒绝、Result 使用不同 `packet_id` 被拒绝。最新 fresh run 为 6/6 通过。
- 第一次匿名网页基线没有结构契约，ChatGPT 自行扩张成 300–500 行 Python、多个 YAML 规则和人工复制流程，证明无契约方案容易过度设计并偏离自动浏览器交接。
- 加入双向契约后，匿名 ChatGPT 返回全部七个结果章节，并明确把“模型未验证”列为风险和未知项。本地 `result` 与 `pair` 校验均通过。
- ChatGPT 的复制回复按钮在匿名内置浏览器中没有产生可读取的剪贴板文本；页面 DOM 仍暴露二级 heading 语义。当前 Skill 已加入 fallback：只读提取两个边界标记之间的可见内容，并按 heading 语义恢复 Markdown，不能假设 `innerText` 会保留 `##`。
- 当前保留的 ChatGPT 页面仍显示“登录”和通用 `ChatGPT` 模型选择器，并打开“登录或注册”弹窗。因此现有证据只证明匿名传输链路，不证明 Plus、Pro 或 GPT-5.6 Sol 的实际使用。

## Constraints
- 不向网页端发送任何真实凭据、个人数据、客户数据、私有笔记、完整未提交 diff 或与当前决策无关的源文件。
- 不安装全局依赖，不修改 Codex 全局配置，不创建 API Key，不使用 OpenAI API；传输必须通过 Codex 内置浏览器中的 ChatGPT 页面。
- 不用通过测试替代真实浏览器证据，也不用匿名 ChatGPT 成功替代已登录目标模型证据。
- 网页模型提出的路径、符号、错误原因和测试命令必须在本地重新验证；不存在的引用必须拒绝或请求修订。
- 涉及删除、数据库 Schema、密钥、CI/CD、部署、push 或发布时，沿用项目和用户现有的即时确认边界。
- 保持 Skill 入口简洁；条件性细节放在 `references/`，机械校验放在脚本中，避免 Luna 每次加载无关说明而浪费 Token。

## Questions
1. 当前双向契约与验证边界是否足以防止“网页建议直接变成本地事实”？请指出仍缺失的最小控制点。
2. 在不增加 API、后台服务或大规模脚本的前提下，怎样记录一次运行确实经过目标网页模型、本地复核和完整测试？
3. 哪些现有内容可以删减或按需加载，以降低 Luna 每次调用该 Skill 的上下文成本，同时不牺牲安全与可验证性？
END_CONTEXT_PACKET
