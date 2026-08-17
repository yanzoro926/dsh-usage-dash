# dsh-usage-dash

DSH web 插件：在侧栏底部显示各 Coding Plan 的剩余额度（OpenCode Go / 火山引擎 CodingPlan / 自定义套餐），点击弹出详情卡片。

## 效果

- 侧栏底部常驻徽章，两行一组按套餐展示**剩余**百分比（折叠成窄栏时显示圆形最紧张窗口的剩余量）：

```
Go 额度
5h: 80%   wk: 90%  30d: 95%
火山
session: 88%   wk: 70%   30d: 45%
```

- 点击徽章 → 徽章上方浮出详情卡：每个套餐一栏，进度条、重置倒计时；卡头有 ⚙ 设置入口
- 剩余 ≤10% 红色、≤40% 橙色预警；每 60 秒自动刷新

## 提供方

| 提供方 | 数据源 | 窗口 | 需要配置 |
|--------|--------|------|----------|
| OpenCode Go | 官方 API `GET https://opencode.ai/zen/go/v1/usage`（优先），fallback 本机 `opencode.db` 本地估算 | 5h / 周 / 月 | 无需（自动用 `~/.local/share/opencode/auth.json` 的 Go key），可在设置里覆盖 token |
| 火山引擎 CodingPlan | 官方 OpenAPI `GetCodingPlanUsage`（通过 `arkcli usage plan`） | session / 周 / 月 | 需安装 [arkcli](https://github.com/volcengine/ark-cli) 并登录：`npm i @volcengine/ark-cli -g` → `arkcli auth login volc-sso` |
| DeepSeek 官方 API | 官方余额 API `GET https://api.deepseek.com/user/balance`（与 platform.deepseek.com/usage 同源） | 余额（总/赠送/充值） | 在设置里填 DeepSeek API key（platform.deepseek.com/api_keys 创建） |
| 自定义套餐 | 任意返回标准 JSON 的额度 API（见下方契约） | 任意 | 在设置里填名称 / URL / 可选 token |

## 自定义套餐（自服务扩展）

在 **设置 → 额度显示 → 自定义套餐** 里添加你自己的套餐。URL 返回的 JSON 自动识别两种格式之一：

```jsonc
// A. opencode 风格
{ "usage": { "rolling": { "percent": 4, "resetsAt": "..." },
             "weekly":  { "percent": 3, "resetsAt": "..." },
             "monthly": { "percent": 1, "resetsAt": "..." } } }

// B. 扁平列表
{ "windows": [ { "label": "5h", "percent": 20, "resetAt": "..." },
               { "label": "weekly", "percent": 40, "resetAt": "..." } ] }
```

- `percent` 为已用百分比（0-100），显示层自动换算剩余量
- `label` 支持：`5h/rolling/rolling5h`、`weekly/week/wk`、`monthly/month/30d`、`session`
- token 可选，默认 `Authorization: Bearer <token>`
- 配置明文存本机 `~/.dsh/storages/dsh-usage-dash-custom.json`（0600）

## 安装

**前置条件**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）。

```bash
# 1. 安装（npm 方式）
dsh plugin --profile web add dsh-usage-dash

# 或从源码安装
git clone https://github.com/yanzoro926/dsh-usage-dash.git
dsh plugin --profile web add file:$(pwd)/dsh-usage-dash

# 2. 重启 dsh web 并刷新页面
#    （在跑 dsh web 的终端 Ctrl+C → 重新执行 dsh web → 浏览器硬刷新 Ctrl+Shift+R）
```

## 设置

- **DSH 设置 → 额度显示**：启用总开关、单订阅显示开关、OpenCode Go token、火山状态、自定义套餐增删
- **侧栏徽章 ⚙ 弹出卡片**：同样的设置表单，快捷入口
- 显示偏好（启用/隐藏/订阅开关）存浏览器 localStorage，刷新后保持

## 安全

`/usage-dash/api/*` 路由带浏览器信任围栏：仅接受 loopback Host（127.0.0.1 / localhost / [::1]）且同源浏览器标记的请求，拒绝跨站（DNS rebinding 防护）。数据是本机用户自己的用量，所有 token 只存本机（0600），接口返回一律脱敏。

## 发布

打 tag 触发 GitHub Actions 自动发布到 npm：

```bash
npm version patch && git push && git push origin vX.Y.Z
```
