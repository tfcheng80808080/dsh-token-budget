# 预算管理插件 · 回归测试用例

> 每次修改插件后运行 `node tests/run.mjs`（或 `npm test`），全部通过再发布。
> 自动生成的结果见 [REPORT.md](./REPORT.md)。

## 运行方式

```bash
cd token-budget/plugin
node tests/run.mjs      # 或 npm test
```

- 有失败时进程以非零码退出，适合接入 CI。
- 报告每次运行覆盖生成 `tests/REPORT.md`（含时间、环境、逐条结果、失败堆栈）。

## 用例清单

### Host（`tests/host.test.mjs`）

| 编号 | 验证点 | 关键预期 |
|---|---|---|
| H1 | 不传配置时的默认值 | 50,000 token / ¥10 / 会话作用域 / Token 模式 / 开启 |
| H2 | `stateSchema` 必须是 zod | 存在 `.parse`，`stateVersion = 5` |
| H3 | `viewSchema` 与下发字段完整性 | 25 个字段全部存在（含三作用域值与各作用域上限） |
| H4 | `assistant/message` 累计 | input/output/cacheRead/cacheWrite 分别累加 |
| H5 | 无 usage / 零用量 | 状态对象不变 |
| H6 | `turn/start` | 本轮清零，会话累计保留 |
| H7 | `command/done` | `rev` 递增且返回新对象（用于触发视图重发） |
| H8 | Token 模式视图 | `used = tokens`，`limit = tokenLimit` |
| H9 | 金额模式视图 | `used = money`，`limit = moneyLimit` |
| H10 | 金额换算 | `(in×2 + out×8 + read×0.5 + write×2) / 1e6` |
| H11 | 三作用域同发 | 会话/任务/项目 token 同时正确 |
| H12 | 项目聚合 | 只合并同 `cwd` 的已加载会话 |
| H13 | 作用域上限隔离 | 会话覆盖不影响项目上限 |
| H14 | 项目上限共享 | 上限存在 `project:<cwd>`，切回会话回到默认 |
| H15 | `/budget show` | 文本包含「已用」「上限」 |
| H16 | `/budget on\|off` | 视图 `enabled` 跟随切换 |
| H17 | `/budget mode` | token/money 切换，非法值报错 |
| H18 | `/budget scope` | session/task/project 切换，非法值报错 |
| H19 | `/budget limit` | 按当前口径写入覆盖值 |
| H20 | `/budget reset` | 覆盖值清除，回到默认 |
| H21 | 非法 limit 参数 | `-1` / `abc` 报错且不改状态 |
| H22 | 超限 + 开启 | `agent.cancel({kind:'hook', reason:'token-budget/exhausted'})` |
| H23 | 超限 + 关闭 | 不 cancel |
| H24 | 未超限 | 不 cancel |
| H25 | `blockOnExceed=false` | 不 cancel |
| H26 | 既有 agent 挂载 | 插件启用前已存在的 agent 也会被挂载 |
| H27 | 重复激活去重 | 同一 agent 只保留一个监听 |
| H28 | 旧闭包读共享状态 | 重载后关闭，旧监听也不再 cancel |
| H29 | 命令别名 | `budget` 与 `tokenbudget` 同时注册 |
| H30 | `model/selection` 折叠 | state/view 的 `model` 跟随事件更新 |
| H31 | 按模型计价 | 命中 `prices[model]` 时用该模型单价 |
| H32 | 未知模型回落 | 使用 `defaultPrice`，view 回显实际单价 |
| H33 | 旧扁平字段兼容 | `priceInputPerMillion` 覆盖默认价 |
| H34 | `request/header` 更新模型 | 每次请求的 header 也能更新当前模型并参与计价 |

### Client（`tests/client.test.mjs`）

| 编号 | 验证点 | 关键预期 |
|---|---|---|
| C1 | dock 胶囊注册 | `conversation.composer.dock` + id `token-budget` |
| C2 | 会话提示渲染器 | `conversation.chat.node` key `budget-stop` |
| C3 | 节点定义 | `kind = budget-stop`，`target = chat` |
| C4 | `turn/start` 匹配 | `{id, role:'start'}` |
| C5 | 预算中止匹配 | aborted + hook + `token-budget/exhausted` → update |
| C6 | 其他结束不匹配 | blocked / 其他 hook / completed 均为 null |
| C7 | 视图节点生成 | 未终止为 null；终止后生成可见节点且 `anchorSeq` 正确 |
| C8 | token 格式化 | 999 / 1.5k / 2.5M / 1.2B / 3.0T |
| C9 | 金额格式化 | 三位小数 |
| C10 | Token 单位 | 1 / 千 / 百万 / 十亿 / 万亿 |
| C11 | 金额单位 | 元 / 角 / 分 |
| C12 | 单位换算 | 输入值 × 倍数 |

## 手工验收项（不适合自动化）

自动化用例覆盖纯逻辑；以下依赖真实 UI，需人工确认：

1. 输入框下方胶囊是否与背景融合、悬停有浅色底；
2. 点击胶囊是否弹出浮框，点击外部 / `Esc` 是否关闭；
3. 点「应用」「恢复默认」后，浮框内上限与胶囊进度条是否立即变化；
4. 超限终止后，会话内是否出现「预算管理：预算已用尽，本轮任务已终止。」提示行；
5. 关闭开关后胶囊是否变淡、且不再阻断。

## 新增用例约定

- 编号连续：Host 用 `H<n>`，Client 用 `C<n>`，禁止复用已删除编号；
- Host 用例一律用 `freshHost('<编号>')` 取全新模块，避免模块级 `RUNTIME` 串味；
- Client 用例通过 `loadClient()` 重新 `eval` 客户端脚本，桩只提供 `react` / `react-dom`；
- 断言失败信息必须带上「期望 / 实际」，便于定位；
- 新增能力时同步更新本文件与 `REPORT.md`（报告由运行器自动重写）。
