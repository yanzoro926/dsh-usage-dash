# dsh-usage-dash

DSH web 插件：在侧栏底部显示编码套餐额度（OpenCode Go 三档 + Codex 官方 rate_limits），点击弹出详情卡片。

## 效果

- 侧栏底部常驻徽章，两行一组按套餐展示百分比（折叠成窄栏时显示圆形最高百分比）：

```
Go 额度
5h: 80%   wk: 90%  30d: 95%
Codex
wk: 44%
```

- 点击徽章 → 右下角浮出详情卡：每个套餐一栏，进度条、已用/上限、重置倒计时；卡头有 ⚙ 设置入口
- 数据来源：
  - **OpenCode Go**：优先官方额度 API `GET https://opencode.ai/zen/go/v1/usage`（Bearer token；token 取自设置弹窗或本机 `auth.json` 的 opencode-go key，自动回退本机 `opencode.db` 本地估算）
  - **Codex**：本机最新 codex 会话里的 `rate_limits`（套餐官方额度口径，含跨设备用量），自动覆盖 WSL 侧 `~/.codex/sessions` 与 Windows 侧 `/mnt/c/Users/<user>/.codex/sessions`
- 每 60 秒自动刷新

## 设置弹窗

卡片头部 ⚙ 按钮打开设置：

- **OpenCode Go**：可粘贴原始 token（`Fe26.2…` 或 `sk-…`），留空则自动用本机 `~/.local/share/opencode/auth.json` 的 Go key；支持保存 / 清除 / 测试连接；token 脱敏显示（前 8 + 后 4 位），明文存于 `~/.dsh/storages/dsh-usage-dash.json`（0600 权限），仅用于本机回环请求，不出本机
- **Codex**：显示已检测到的套餐/窗口/快照时间，可立即刷新；重新登录请在终端运行 `codex login`

## 限额口径（OpenCode Go 官方套餐）

| 窗口 | 上限 | 边界 |
|---|---|---|
| 5h 滚动 | $12 | 最近 5 小时 |
| 本周 | $30 | UTC 周一 00:00 起算 |
| 本月 | $60 | UTC 自然月 |

来源：[openusage opencode-go provider](https://github.com/openusage-community/openusage/blob/main/docs/providers/opencode-go.md)。
注：本地 SQLite 只记录本机用量；跨设备/远端用量无法统计。月度窗口目前按 UTC 自然月（订阅锚点推断后续可加）。

## Codex 额度

- 数据 = codex 会话文件里 `token_count` 事件的 `rate_limits`（`plan_type`、各窗口 `used_percent`/`window_minutes`/`resets_at`），是套餐官方口径，不自己估算
- 窗口按 `window_minutes` 动态映射：300 → `5h`、10080 → `wk`、43200/40320/44640 → `30d`，其他值按可读单位显示
- 当前 ChatGPT Plus 的 codex 通常只报一个周窗口（10080 分钟）；旧版本会话可能报 5h + 周双窗口，均自动适配
- 快照取「最新线程的 session 文件尾部」：先查 `~/.codex/sqlite/state_5.sqlite`（或 `~/.codex/state_5.sqlite`）的 `threads.rollout_path`，失败时按 mtime 扫描两侧 sessions 目录；有缓存，codex 没写新会话时轮询零开销
- 快照时间显示在卡片上（"数据 x 小时前"），resets_at 超出窗口 2 倍时长时视为无效不显示倒计时

## 安装

**前置条件**：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` CLI）。

```bash
# 1. 克隆仓库
git clone https://github.com/yanzoro926/dsh-usage-dash.git

# 2. 安装到 DSH web profile
dsh plugin --profile web add file:$(pwd)/dsh-usage-dash

# 3. 重启 dsh web 并刷新页面
#    （在跑 dsh web 的终端 Ctrl+C → 重新执行 dsh web → 浏览器硬刷新 Ctrl+Shift+R）
```

**可选依赖**（仅对应功能的订阅者需要）：

| 功能 | 依赖 | 安装 |
|------|------|------|
| 火山引擎 CodingPlan | [arkcli](https://github.com/volcengine/ark-cli) | `npm i @volcengine/ark-cli -g`，然后 `arkcli auth login volc-sso` |

其余功能（OpenCode Go / Codex）**零外部依赖**，插件自动读取本机已有数据。

## 提供方

| 提供方 | 数据源 | 窗口 | 需要配置 |
|--------|--------|------|----------|
| OpenCode Go | 官方 API `GET /zen/go/v1/usage`（优先），fallback 本机 `opencode.db` | 5h / 周 / 月 | 无需（自动用 `~/.local/share/opencode/auth.json` 的 key），可在设置里覆盖 token |
| Codex | 本机最新 codex 会话的 `rate_limits` 字段 | 5h / 周（按 `window_minutes` 自适应） | 无需（本机已有 codex 会话时自动取数） |
| 火山引擎 CodingPlan | 官方 OpenAPI `GetCodingPlanUsage`（通过 `arkcli usage plan`） | session / 周 / 月 | 需安装 arkcli 并登录（见上方可选依赖） |

## 设置

- **DSH 设置 → 额度显示**：启用开关、单订阅显示开关、OpenCode Go token 配置、火山/Codex 状态与刷新
- **侧栏徽章 ⚙ 弹出卡片**：同样的设置表单，快捷入口
- 显示偏好（启用/隐藏/订阅开关）存浏览器 localStorage，刷新后保持

## 安全

`/usage-dash/api/*` 路由带浏览器信任围栏：仅接受 loopback Host（127.0.0.1 / localhost / [::1]）且同源浏览器标记的请求，拒绝跨站（DNS rebinding 防护）。数据是本机用户自己的用量，无需任何 token。
