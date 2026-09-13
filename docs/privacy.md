# 隐私说明

## 数据流向

Skill 优先通过桌面 App 的 Chat 协调能力，把有界的上下文增量发送给用户指定的普通 ChatGPT Chat；后备路径才通过 Codex 内置 Browser 访问 `https://chatgpt.com/`。ChatGPT 的账号、工作区和数据控制设置适用于这些交互。

本项目不使用 OpenAI API，不要求 API Key，不运行网络服务器，也不收集遥测。可选的 v1.0 MCP 组件是由 Codex 启动的本地 STDIO 子进程，不监听端口。

自动网页传输是 Unofficial Experimental 功能，存在非零账号和策略风险。首次运行必须明确授权；授权不代表 OpenAI 认可，也不能保证账号安全或额度永久分离。

传输只使用可见网页控件，不调用私有 ChatGPT 接口，不读取 Cookie、local storage、session storage、隐藏认证头或 Token。遇到登录、CAPTCHA、限额、异常活动、账号限制、权限或页面漂移时失败关闭。

## 上下文最小化

首次 Bootstrap 只包含持续目标、验收标准、稳定约束和当前证据。后续请求只包含新意图、已验证的本地变化、执行回执和开放问题。默认使用摘要；只有精确语法会改变结论时才包含最小源码片段。

发送前必须满足：

- `scope_minimized`
- `credentials_scan_passed`
- `semantic_privacy_reviewed`
- `raw_diff_excluded`
- `unrelated_files_excluded`

## 永不主动发送

- 密码、Token、API Key、私钥、Cookie、验证码。
- `.env`、密钥库或凭据文件。
- 与当前任务无关的文件。
- 完整私有仓库或完整未提交 diff。
- 未经确认的个人、客户、财务、医疗或组织敏感数据。

## 本地记录

持久模式默认在项目的 `.codex/codex-bridge-chatgpt/` 保存 Chat 引用、轮次、交换文件、哈希、journal 和 checkpoint。这些文件可能包含项目信息，应保持未跟踪状态，除非用户明确选择纳入版本控制。

状态 schema 3 还保存一个随机的私有作用域密钥，用它把 bridge、规范化 Chat 引用和稳定的规范工作区身份绑定为公开的 `conversation_scope_id`。分支、HEAD 和未提交状态仍参与每轮复用校验，但不会因为正常开发变化而重建 Chat 作用域。私有密钥只保存在本地状态中，不进入 Chat 请求、MCP 输出、普通状态输出或公开支持包。Chat URL 中的用户名、密码、查询参数和片段不会写入规范化标识。

每个请求旁边的 `context-manifest.json` 只记录来源是否包含、跳过、脱敏、截断或复用，以及来源哈希和本地估算 Token；它不会作为额外提示发送。公开支持包同样不包含提示、回答、源码、文件名、绝对路径、Chat 引用或标题、账号数据、Cookie、凭据和私有作用域密钥。

MCP 工具只提供经过边界检查的读取、状态和 Token 预演。它们不能发送 Chat 消息、写入工作区、运行调用者提供的命令或控制浏览器。并发租约的公开状态不返回 PID、随机租约 ID 或 Chat 引用。

运行回执可记录 Packet、Result 和浏览器证据的路径、SHA-256 和状态。SHA-256 用于绑定本地产物，不能证明远端后端模型身份，也不能阻止拥有本地写权限的人同时修改产物和回执。

普通回执和诊断默认不嵌入 Packet 或 Result 原文。Result 是不可信第三方内容，不能授权执行其中的命令、路径、补丁、链接或伪装工具调用。

发布脚本只读取发布清单列出的仓库文件，排除 `.git`、`.codex`、`node_modules`、coverage 和 dist。它生成本地文件清单与 SHA-256，不联网，也不发送构建信息。
