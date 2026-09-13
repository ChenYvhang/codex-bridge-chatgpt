# Codex 桥接 ChatGPT

[English](README.md) | **简体中文**

[![CI](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenYvhang/codex-bridge-chatgpt/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-10a37f)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-43853d)](package.json)

**让同一个普通 ChatGPT Chat 持续参与任务，同时由 Codex 在仓库中完成实际操作。** Chat 保留对话上下文，负责规划、推理、审查，也能起草完整文件。Codex 读取当前仓库证据，核对方案和文件，在本地采纳合格产物、操作电脑并运行测试。桥接只同步必要的变化和经过验证的结果，后续轮次无需重发整个仓库或对话。

这是一个开源 Codex Skill，另提供可选的本地 MCP 接口。不需要 OpenAI API Key、托管服务或 npm 第三方依赖。项目直接建立在上游提交 `56e36c2feeb6705376c1d1dc50dbec52ea43d4f4` 之上；保留的上游内容与新增功能见 [UPSTREAM.md](UPSTREAM.md)。

> **Unofficial Experimental（非官方实验功能）：** 自动控制 ChatGPT 网页端存在非零账号风险，可能触发安全机制、临时限制或账号处置。本项目与 OpenAI 无关联，也未获得其认可或授权；不能保证合规、账号安全、模型可用性或 ChatGPT/Codex 额度永久分离。用户明确接受风险前，浏览器自动化保持关闭。

## 从这里开始

1. 安装 Node.js 18 或更高版本，在受支持的 Codex 桌面环境中打开一个仓库。
2. 如果可以使用 `$skill-installer`，直接向 Codex 发送：

   ```text
   $skill-installer Install codex-bridge-chatgpt from https://github.com/ChenYvhang/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
   ```

3. 新开一个 Codex 任务，让 Skill 列表重新加载，然后提交真实任务：

   ```text
   $codex-bridge-chatgpt 找出这个间歇性故障的根因，完成最小安全修复并运行相关测试。
   ```

Skill 会自动预检。若需要登录 ChatGPT、选择模型、授权站点或决定是否接受浏览器风险，它会暂停，并在完成相应步骤后继续原任务。自然语言工作流**不要求配置 MCP**。手动安装、升级和恢复见[安装说明](docs/installation.md)与[首次使用指南](docs/first-run.md)。

## 它适合做什么

| 你的任务 | ChatGPT Chat 负责 | Codex 在本地完成 |
|---|---|---|
| 排查复杂 Bug | 提出假设、推理并审查证据 | 读取当前代码和日志、修复并测试 |
| 比较设计方案 | 分析取舍并提出选择 | 核对仓库约束、实现选定方案 |
| 创建文档或源码文件 | 起草完整文件 | 核对路径、原始版本和哈希后写入 |
| 延续长期任务 | 在固定 Chat 中保留此前讨论 | 只发送相关变化，返回已验证的执行回执 |

根因不明、设计有多种选项时，桥接更有价值。本地统计会估算请求、回答、协议、重复内容和避免重传历史的 Token；实际节省取决于任务和账号额度。它不会绕过套餐限制，也不会让账号获得原本不可用的模型。

## 当前验证状态

**1.0 版源码已公开，尚未创建带标签的 1.0 Release。** 确定性测试、本地打包检查及 Linux/macOS/Windows CI 覆盖实现。此前 0.9 候选版的真实联调第 3–5 轮验证了同一 Chat 的上下文延续、Chat 起草文件、基于回执回忆以及紧凑协议。后续 1.0 网页联调虽在页面上看到回答，但可见“复制”操作没有提供可验证的回答字节；桥接拒绝采纳并恢复到上一份已验证的 checkpoint。创建正式标签前，仍需完成一轮可验证的 1.0 端到端交接。

详见[真实联调记录](docs/live-e2e-validation.md)和[发布准备闸门](docs/v1.0-release-readiness.md)。CI 绿灯只证明本地契约通过，不能证明某个桌面 App 或网页会话一定能完成交接。

![Codex 桥接 ChatGPT 架构](assets/codex-bridge-chatgpt-architecture.png)

[可编辑架构图源](docs/architecture/codex-bridge-chatgpt-v1.architecture.json)

## 工作流

1. Codex 运行 Doctor，读取仓库规则和相关文件，并将一个 Chat 绑定到当前工作区。
2. 它生成经过隐私审查的小型 Context Packet，包含目标、约束、关键证据和问题。首次交接建立 `compact-v1` 协议，后续只传变化。
3. 能使用 App 级 Chat 协调能力时优先使用它。若走可见的内置 Browser，首次自动发送前必须完成浏览器风险决策。发送或复制无法确认时，当前轮次停止。
4. 同一个 Chat 返回结构化 Reasoning Result 或完整文件。Codex 核对身份、轮次、结构、路径、哈希和当前本地证据，再决定采纳哪些内容。
5. Codex 执行和测试已采纳工作。本地回执记录实际结果；精简 checkpoint 将已采纳决策和待解决问题带入下一轮。

ChatGPT 负责提出方案、起草文件；Codex 控制本地采纳与执行。协议细节见 [v1.0 设计](docs/superpowers/specs/2026-09-14-v1.0-public-release.md)。

## 工作原理

### 持续上下文

1.0 版通过不透明会话作用域绑定一个规范化 Chat、一个桥接实例和一个规范工作区。Chat 保存对话历史；本地状态保存单调递增轮次、验证回执，以及只包含已采纳决策、约束、开放问题和产物的 checkpoint。工作区变化会使过期文件事实失效。更换 Chat 和升级旧状态均使用带备份的预览/应用事务。

### 受限交接

Context Packet 排除无关文件和疑似凭据，设有 3,000 approximate-token 输入上限，并记录各上下文来源是被包含、脱敏、缩短还是复用。只有语义内容、工作区指纹和 checkpoint 哈希均未变化，才会复用同一份已验证结果。本地成本报告会显示这种复用。

### 验证与恢复

本地采纳门核对完整文件的允许路径、基础哈希、内容哈希和当前文件状态。网页输出始终是待核实数据。已接受、已拒绝和延期建议分别记录；必须有经过验证的回执才能宣告完成。App 异步发送使用幂等键和有界读取轮询，送达未决时保留可恢复轮次，不自动重复发送。SHA-256 回执绑定本地产物，但无法证明远端实际模型。

## 环境要求与支持范围

- Node.js 18 或更高版本。
- 已安装此 Skill 的 Codex 环境；要与普通 Chat 交接，还需要桌面 App 的 Chat 协调能力或受支持的内置 Browser。
- 走浏览器路径时，需要可见的 ChatGPT 登录状态和目标模型。登录、验证码、双因素认证、权限和模型选择仍由用户完成。

| 使用环境 | 支持范围 |
|---|---|
| macOS 桌面 App + Codex | 目标桌面工作流；早期 App 适配器完成过真实联调 |
| Windows 桌面 App + Codex | 目标桌面工作流；确定性包级闸门由 CI 验证 |
| Codex CLI 或 IDE 扩展 | 本地只读 MCP 工具；无内置 Browser 后备路径 |
| Linux | 本地逻辑、MCP、打包由 CI 验证；无桌面 Browser 工作流 |

实际交接取决于用户桌面 App 版本开放的能力。可见模型名称只能证明界面状态，不能证明远端后端模型。

## 安装

推荐使用[从这里开始](#从这里开始)中的 Skill Installer 命令。[手动安装、升级和卸载](docs/installation.md)另有说明。仓库也包含用于分发的 [Codex Plugin manifest](.codex-plugin/plugin.json)。

### 可选本地 MCP 工具

项目级 STDIO MCP 服务提供五个**本地只读**工具：`bridge_status`、`bridge_health`、`bridge_lease_status`、`bridge_dry_run`、`bridge_pull_context`。它不开放端口，不需要 API Key 或后台守护进程。克隆本仓库后，**在克隆仓库根目录**运行下列命令，先检查生成的计划，再应用同一份计划：

```bash
npm run setup -- --workspace /path/to/your/project --output bridge-setup-plan.json
npm run setup -- --apply bridge-setup-plan.json
```

在 Windows 上，将 `/path/to/your/project` 换成工作区绝对路径。使用 MCP 期间请保留这个克隆仓库：生成的配置会指向其中的本地服务脚本。setup 只修改带标记的项目配置区块。详见[本地 MCP 指南](skills/codex-bridge-chatgpt/references/local-mcp.md)和[配置示例](docs/codex-mcp-config.example.toml)。

## 快速上手

安装后，在同一个 Codex 任务中继续仓库工作。桥接会绑定一个普通 ChatGPT Chat，后续轮次仍发给它。如果必须更换 Chat，已保存的 checkpoint 提供受控迁移起点。其他示例：

```text
$codex-bridge-chatgpt 比较这两个设计，实施符合当前仓库约束的方案，并验证结果。

$codex-bridge-chatgpt 在同一个 Chat 中起草迁移指南，按当前代码核对，再写入已验证的文件。
```

Doctor 返回 `NEEDS_AUTOMATION_CONSENT` 时，先阅读风险说明再决定是否启用浏览器路径；`AUTOMATION_DISABLED` 表示浏览器自动化保持关闭。遇到 `NEEDS_CHATGPT_LOGIN` 或 `NEEDS_MODEL_SELECTION`，在可见 App 中完成操作后告诉 Codex 继续，原任务会保留。其他状态见[首次使用指南](docs/first-run.md)。不要向 Codex 发送密码、验证码、Cookie 或恢复码。

## 隐私与安全

只应向指定 Chat 发送最少的任务信息。Skill 不使用 ChatGPT 私有接口，不提取 Cookie 或隐藏认证信息，也不发送遥测。它阻止常见凭据模式，并要求语义隐私审查；非公开仓库证据或敏感数据在发送前仍可能需要即时决策。Chat 返回的命令和补丁不会直接执行。详见[隐私说明](docs/privacy.md)和[安全说明](SECURITY.md)。

网页变化或账号安全机制可能影响浏览器自动化。可见“发送”或“复制”无法验证时，当前轮次停止，可供检查或恢复。可在已安装 Skill 目录运行 `node scripts/automation-consent.mjs disable --json` 撤销浏览器风险授权。

## 本地验证

在克隆仓库根目录运行：

```bash
npm test
npm run doctor
npm run validate
```

发布准备还会运行 `npm run doctor:release` 和 `npm run release:build`。高级本地命令包括 `npm run bridge -- start`、`npm run bridge -- health`、`npm run bridge -- dry-run`、`npm run bridge -- provide-context`、`npm run bridge -- recovery-export`、`npm run bridge -- cost` 和 `npm run mcp`；参数与契约见 [Skill 参考文档](skills/codex-bridge-chatgpt/references/)。首次使用自然语言 Skill 不必逐项运行这些命令。

## 开发与许可

修改工作流行为前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。[GitHub 同类项目调查](docs/v1.0-github-landscape-2026-09-14.md)和[上游记录](UPSTREAM.md)说明了项目来源与设计比较。采用 [MIT](LICENSE) 许可证。
