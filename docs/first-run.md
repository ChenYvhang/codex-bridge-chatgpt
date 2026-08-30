# 首次使用

用户只需要提交一个真实任务，不需要先运行 `setup`：

```text
$codex-bridge-chatgpt 帮我定位这个复杂 Bug 的根因并完成修复
```

## 自动流程

1. 本地 Doctor 检查 Skill 文件和 Node.js。
2. Codex 检查桌面 App 和内置 Browser 能力。
3. 内置 Browser 打开或接管 `https://chatgpt.com/`。
4. 页面未登录时，Skill 返回 `NEEDS_CHATGPT_LOGIN` 并请用户接管。
5. 用户登录后回复“已登录”。Skill 重新检查浏览器状态并继续原任务。
6. 目标模型不可用时，Skill 返回 `NEEDS_MODEL_SELECTION`，不会静默更换模型。
7. 状态为 `READY` 后才会构造和发送 Packet。

## 登录安全

- 登录、验证码、双因素认证和 CAPTCHA 由用户完成。
- 不要把密码、验证码、Cookie 或恢复码发到聊天中。
- Skill 不检查浏览器本地存储、Cookie 文件或密码管理器。
- 登录完成后无需重新描述原任务。

## 发送前确认

公开源码或纯通用问题可以直接生成 Packet。Packet 含非公开仓库证据时，Codex 会在发送前说明目的地和数据范围，并请求即时确认。
