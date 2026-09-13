# 首次使用

安装 Skill 并新开一个 Codex 任务后，在仓库中提交真实需求：

```text
$codex-bridge-chatgpt 帮我定位这个复杂 Bug 的根因并完成修复
```

无需预先运行 `setup`。Skill 会运行本地 Doctor，读取仓库规则，再判断当前环境能否与一个现有的普通 ChatGPT Chat 直接协调。它会把该 Chat 绑定到当前工作区；后续轮次继续使用同一个 Chat，只同步必要的变化与经过验证的结果。

## 交接路径

1. **App 直接协调可用：** Codex 核对目标 Chat，准备经过隐私审查的请求，发送一次，并按幂等键等待对应回答。发送确认只表示已排队；若超时，会保留可恢复状态，不擅自重复发送。
2. **需要网页后备路径：** 这是 Unofficial Experimental 自动化，存在非零账号风险。Skill 先显示风险说明，并在用户明确同意后才持久化启用状态。拒绝或撤销后不会控制 ChatGPT 网页端。
3. **网页预检：** 授权就绪后，Codex 才检查桌面 App、内置 Browser、可见登录状态及目标模型。登录、验证码、双因素认证、CAPTCHA、站点权限和模型选择由用户完成；回复“已登录”或“已选好模型”后，Codex 重新检查并继续原任务。
4. **本地采纳：** 无论哪条路径，Chat 返回的建议或完整文件都要经过身份、轮次、路径、内容和当前仓库状态检查。Codex 采纳合格部分、执行、测试，并把实际结果同步给同一个 Chat。

网页路径只允许一次可见发送和一次可见复制。如果回答字节无法验证，当前轮次停止并保留恢复信息。页面上看见回答，不代表桥接已经成功导入它。

## 常见状态

| 状态 | 该做什么 |
|---|---|
| `NEEDS_AUTOMATION_CONSENT` | 阅读网页自动化风险说明，明确决定是否启用后备路径 |
| `AUTOMATION_DISABLED` | 网页自动化已被拒绝或撤销；可继续本地工作 |
| `MISSING_RUNTIME` | 安装 Node.js 18 或更高版本 |
| `INVALID_INSTALLATION` | 检查并重新安装 Skill 目录 |
| `NEEDS_DESKTOP_APP` / `NEEDS_BROWSER` | 使用受支持的桌面环境，检查内置 Browser 能力 |
| `NEEDS_CHATGPT_LOGIN` | 在可见页面中自行登录，然后让 Codex 继续 |
| `NEEDS_MODEL_SELECTION` | 在可见界面中选择所需模型，不会静默替换 |
| `NEEDS_SITE_PERMISSION` | 在桌面 App 中允许访问 `chatgpt.com` |
| `READY` | 当前预检层已通过，Codex 继续原任务 |

## 隐私与撤销

不要将密码、验证码、Cookie 或恢复码发送给 Codex。发送非公开仓库证据前，Codex 会说明目标 Chat 和信息范围，并根据敏感程度请求即时确认。Skill 不读取浏览器 Cookie、隐藏认证信息或私有 ChatGPT 接口。

在**已安装 Skill 的目录**运行下列命令，可撤销网页后备路径授权：

```bash
node scripts/automation-consent.mjs disable --json
```

`setup` 只用于可选的项目级只读 MCP 工具，按[安装说明](installation.md)预览和应用即可；自然语言工作流不依赖它。
