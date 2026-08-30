# Codex 桥接 ChatGPT

让 Codex 负责读取项目、修改和测试，让 ChatGPT 网页端负责高成本推理。整个过程通过一个可安装 Skill 串联，用户只需要一句话。

```text
$codex-bridge-chatgpt 帮我诊断并修复这个复杂问题
```

![Codex 桥接 ChatGPT 架构](assets/codex-bridge-chatgpt-architecture.png)

可维护图源见 [docs/architecture/codex-bridge-chatgpt-v1.architecture.json](docs/architecture/codex-bridge-chatgpt-v1.architecture.json)。

## 它解决什么问题

复杂架构、疑难 Bug 和多方案权衡需要更强推理，但仓库搜索、文件修改和测试更适合留在 Codex 本地执行。本项目把两者分开：

- Codex 收集最小证据，压缩为 1–3K approximate-token Packet。
- ChatGPT 网页端返回结构化建议，不获得仓库访问权。
- Codex 本地复核每条建议，重新构造修改并运行测试。
- Packet、Result、浏览器证据和运行状态写入可验证回执。

## V1 支持范围

| 环境 | 支持情况 |
|---|---|
| macOS ChatGPT 桌面 App 中的 Codex | 支持 |
| Windows ChatGPT 桌面 App 中的 Codex | 支持 |
| Codex CLI | 不支持内置 Browser 桥接 |
| Codex IDE 扩展 | 不支持内置 Browser 桥接 |
| Linux | V1 不支持 |

V1 不绕过账号套餐、工作区策略、模型权限、登录验证或网站安全机制。

## 安装

在 Mac 或 Windows ChatGPT 桌面 App 的 Codex 中发送：

```text
$skill-installer Install codex-bridge-chatgpt from https://github.com/anightmonarch/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
```

安装后新开一个任务，直接调用：

```text
$codex-bridge-chatgpt 审查这个方案并完成本地修改和测试
```

仓库同时包含 Plugin manifest。V1 可以从 GitHub 直接安装 Skill；Plugin 目录分发是后续发布通道，工作流仍使用同一份 `SKILL.md`。

完整安装、升级和卸载说明见 [docs/installation.md](docs/installation.md)。

## 自动 Doctor

每次调用都会先运行自动预检，不需要单独执行 `setup`：

1. 检查 Skill 文件和 Node.js 运行时。
2. 检查是否运行在 Mac/Windows ChatGPT 桌面 App。
3. 检查 Codex 内置 Browser 是否可用。
4. 检查内置 Browser 中的 ChatGPT 登录状态。
5. 检查用户要求的模型是否真实可见。
6. 通过后继续原任务。

需要登录、模型选择或站点授权时，Skill 会保留原任务并等待用户接管页面。用户不需要重新描述问题，也不要把密码、验证码或 Cookie 发给 Codex。

首次使用流程见 [docs/first-run.md](docs/first-run.md)，状态排查见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 隐私边界

使用此 Skill 会把经过最小化和脱敏的 Context Packet 发送到 `chatgpt.com`。不会主动发送：

- 密码、Token、私钥、Cookie、验证码。
- `.env` 或原始环境文件。
- 与当前决策无关的源码和文档。
- 完整未提交 diff。
- 个人数据或客户数据。

正则扫描不能识别所有业务敏感信息，因此发送前还要求语义隐私审查。详见 [docs/privacy.md](docs/privacy.md)。

## 本地验证

项目无 npm 依赖。Node.js 18 或更高版本即可运行：

```bash
npm test
npm run doctor
npm run validate
```

CI 在 macOS 和 Windows 上执行同一组命令。

## 安全原则

- ChatGPT 只提供建议，Codex 才能修改仓库。
- 网页输出永远按不可信数据处理。
- Result 中的命令、补丁和路径禁止直接执行。
- UI 显示的模型是可审计证据，不是后端模型的密码学证明。
- 删除、数据库变更、部署、push 和公开发布继续遵守用户原有确认边界。

安全问题请查看 [SECURITY.md](SECURITY.md)。

## 开发

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE)
