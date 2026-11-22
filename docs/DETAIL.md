# 预算管理

按**会话**或**任务**设置 **Token** / **金额** 预算；输入框下方只显示一个紧凑胶囊，点击弹出二级浮框调整上限；超限时**直接阻断输入**。

## 界面

- 输入框下方显示「预算 12.3k / 50k」胶囊（含迷你进度条，超过 80% 变黄、超限变红）。
- 点击胶囊弹出浮框：
  - **Token / 金额** 两种口径切换
  - 当前已用 Token 与金额
  - 作用域（会话 / 任务）
  - 上限输入框 + 应用
  - 恢复默认

## 口径

- **Token**：`uncachedInput + output + cacheRead + cacheWrite` 的累计和。
- **金额**：按模型价目表换算（元/百万 token）：
  ```
  金额 = ( 未命中输入 × input + 缓存读 × cacheRead
         + 缓存写 × cacheWrite + 输出 × output ) / 1,000,000
  ```
  - `usage.inputTokens` 在 DSH 中是**未命中缓存的输入**，缓存命中单独记在 `cacheReadTokens`，两者不会重复计费；
  - 当前模型 id 来自 `model/selection` 会话事件，命中 `prices[model]` 就用该模型单价，否则用 `defaultPrice`；
  - 旧的扁平字段（`priceInputPerMillion` 等）仍兼容，会覆盖 `defaultPrice` 对应项。

## 配置（cordis.patch.yml）

```yaml
enabled: true
scope: session                 # session | task | project
mode: token                    # token | money
tokenLimit: 50000
moneyLimit: 10
currency: '¥'
defaultPrice:                  # 未登记模型的兜底价（元 / 百万 token）
  input: 2
  output: 8
  cacheRead: 0.5
  cacheWrite: 2
prices:                        # 按模型覆盖
  deepseek-v4-flash:
    input: 2
    output: 8
    cacheRead: 0.5
    cacheWrite: 2
  deepseek-v4-pro:
    input: 4
    output: 16
    cacheRead: 1
    cacheWrite: 4
blockOnExceed: true
```

> 单价只是默认值，请按你实际使用的模型价格调整；未知模型自动使用 `defaultPrice`。

## 命令

- `/budget` 或 `/budget show`：查看当前预算状态
- `/budget mode token|money`：切换口径
- `/budget limit <n>`：设置本会话（当前口径）的上限
- `/budget reset`：恢复全局默认

`/tokenbudget` 是 `/budget` 的兼容别名。

## 限制

- 会话级上限与口径保存在进程内存中，Host 重启后回到全局默认。
- 已存在的 Agent 需重新进入或新开会话后才会挂载阻断监听。
- 统计依赖 provider 返回的 `usage`；未返回用量的调用不计入。
