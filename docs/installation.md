# 安装、升级与卸载

## 前置条件

- Mac 或 Windows ChatGPT 桌面 App。
- Codex 可用。
- ChatGPT 桌面 App 已更新到包含 Skills 和内置 Browser 的版本。
- Node.js 18 或更高版本。Doctor 会检查版本，不满足时返回 `MISSING_RUNTIME`。

Codex 登录与内置 Browser 中的 ChatGPT 登录是两个独立状态。Skill 不读取或迁移普通浏览器的 Cookie。

网页后备路径是 Unofficial Experimental 功能，存在非零账号和策略风险。仅当 App 无法直接协调普通 Chat，且需要网页自动化时，Skill 才会展示完整说明；用户明确接受前不会打开或控制 ChatGPT 网页端。该授权不代表 OpenAI 认可，也不能保证账号安全或额度永久分离。

## 推荐安装

在 Codex 中发送：

```text
$skill-installer Install codex-bridge-chatgpt from https://github.com/ChenYvhang/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
```

安装完成后新开一个任务，使 Codex 重新加载 Skill 列表。

## 验证安装

直接发送真实任务：

```text
$codex-bridge-chatgpt 分析这个仓库问题并给出经过本地测试的修复
```

Skill 会自动运行 Doctor，并优先检查能否通过 App 直接协调同一个普通 Chat。只有退回网页路径时才检查浏览器自动化授权；若返回 `NEEDS_AUTOMATION_CONSENT`，明确接受后才检查 Browser、登录和模型。各层就绪后会继续原任务。

如果需要本地只读 MCP 工具，先克隆本仓库，在**克隆仓库根目录**生成并检查目标项目的配置计划，再应用同一份计划：

```bash
npm run setup -- --workspace /path/to/your/project --output bridge-setup-plan.json
npm run setup -- --apply bridge-setup-plan.json
```

在 Windows 上，将示例项目路径换成实际工作区绝对路径。使用 MCP 期间请保留这个克隆仓库，因为生成的配置指向其中的本地服务脚本。

这一步只管理 `.codex/config.toml` 中带标记的区块，不是使用自然语言 Skill 的前置条件。发布包维护者还应运行 `npm run doctor:release` 和 `npm run release:build`；后者会验证两次构建字节一致。

撤销全自动桥接：

```bash
node scripts/automation-consent.mjs disable --json
```

## 升级

安装器不会覆盖同名目录。升级时先保留当前目录作为备份，再使用 Skill Installer 安装新版本。确认新版本 Doctor、状态迁移和验证命令通过后，再清理备份。Schema v1/v2 状态必须显式运行 `context-state.mjs migrate-state --workspace <root>`；工具会保留经哈希复核的原始状态。风险说明版本变化后，旧授权失效并要求重新决策。

不要让升级脚本覆盖其他 `$CODEX_HOME/skills` 内容。

## 卸载

先在已安装 Skill 目录运行 `node scripts/automation-consent.mjs disable --json`，明确撤销自动桥接。授权状态与 Skill 安装目录分离；只移除 Skill 而不撤销状态，之后重新安装同一披露版本时仍会保持原决策。

如果曾安装项目 MCP，先生成 `--action remove` 计划并应用；它只移除受管配置区块并保留 `.codex/codex-bridge-chatgpt/` 上下文。然后只移除 `$CODEX_HOME/skills/codex-bridge-chatgpt`。不要删除整个 `$CODEX_HOME`，其中可能包含其他 Skills、配置和会话。

卸载后重启桌面 App 或新开任务，确认 Skill 不再出现在列表中。
