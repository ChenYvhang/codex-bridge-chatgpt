# 安装、升级与卸载

## 前置条件

- Mac 或 Windows ChatGPT 桌面 App。
- Codex 可用。
- ChatGPT 桌面 App 已更新到包含 Skills 和内置 Browser 的版本。
- Node.js 18 或更高版本。Doctor 会检查版本，不满足时返回 `MISSING_RUNTIME`。

Codex 登录与内置 Browser 中的 ChatGPT 登录是两个独立状态。Skill 不读取或迁移普通浏览器的 Cookie。

## 推荐安装

在 Codex 中发送：

```text
$skill-installer Install codex-bridge-chatgpt from https://github.com/anightmonarch/codex-bridge-chatgpt/tree/main/skills/codex-bridge-chatgpt
```

安装完成后新开一个任务，使 Codex 重新加载 Skill 列表。

## 验证安装

直接发送真实任务：

```text
$codex-bridge-chatgpt 分析这个仓库问题并给出经过本地测试的修复
```

Skill 会自动运行 Doctor。`READY` 表示本地安装、Browser、登录和模型预检都已通过。

## 升级

V1 的安装器不会覆盖同名目录。升级时先保留当前目录作为备份，再使用 Skill Installer 安装新版本。确认新版本 Doctor 和验证命令通过后，再清理备份。

不要让升级脚本覆盖其他 `$CODEX_HOME/skills` 内容。

## 卸载

只移除 `$CODEX_HOME/skills/codex-bridge-chatgpt`。不要删除整个 `$CODEX_HOME`，其中可能包含其他 Skills、配置和会话。

卸载后重启桌面 App 或新开任务，确认 Skill 不再出现在列表中。
