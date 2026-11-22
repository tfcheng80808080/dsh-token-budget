# 预算管理 · DSH Token / Money Budget Manager

给 DeepSeek Harness 的每个会话装上「流量表」：按 **Token** 或 **金额** 设预算，输入框下方实时显示用量，超限直接阻断。

> Set a token or money budget per conversation, task, or project. Live usage sits under the composer; input is blocked once the budget is exhausted.

仓库 / Repository: https://github.com/tfcheng80808080/dsh-token-budget

![budget pill](https://img.shields.io/badge/dsh-%E2%89%A50.2.2--rc.5-blue)

## 功能

- **紧凑胶囊**：输入框下方只有一根进度条（>80% 琥珀、超限红色），与背景融合、悬停有底色
- **二级浮框**：点击展开，切换口径 / 作用域、查看已用与上限、设置新上限、恢复默认、开关阻断
- **两种口径**：Token（1 / 千 / 百万 / 十亿 / 万亿）与金额（元 / 角 / 分）
- **按模型计价**：命中 `prices[model]` 用该模型单价，否则回落 `defaultPrice`；区分未命中输入 / 缓存读 / 缓存写 / 输出
- **三种作用域**：会话、任务（每轮重置）、项目（同工作区已加载会话共享）
- **硬阻断**：到上限时在 `agent/pre-step` 中止本轮，**不发起模型请求**，并在会话里显示「预算管理：预算已用尽，本轮任务已终止。」
- **可关闭**：关掉阻断后仍统计，只是不拦截

## 安装

```bash
# 从 npm
dsh plugin --profile desktop add @tfcheng80808080/dsh-token-budget

# 或本地目录（开发调试）
dsh plugin --profile desktop add /path/to/token-budget/plugin
```

在 DSH「设置 → 插件」里启用，然后**刷新页面**。

## 使用

点击输入框下方的胶囊 → 浮框里：

| 操作 | 说明 |
|---|---|
| Token / 金额 | 切换统计口径 |
| 会话 / 任务 / 项目 | 切换统计范围 |
| 输入框 + 单位 + 应用 | 设置当前作用域的上限 |
| 恢复默认 | 回到全局默认上限 |
| 开启 / 关闭 | 只统计，或超限阻断 |

命令：`/budget`、`/budget on|off`、`/budget mode token|money`、`/budget scope session|task|project`、`/budget limit <n>`、`/budget reset`。

## 配置

```yaml
enabled: true
scope: session                 # session | task | project
mode: token                    # token | money
tokenLimit: 50000
moneyLimit: 10
currency: '¥'
defaultPrice:
  input: 2
  output: 8
  cacheRead: 0.5
  cacheWrite: 2
prices:
  deepseek-v4-pro: { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 }
blockOnExceed: true
```

金额 = `(未命中输入×input + 缓存读×cacheRead + 缓存写×cacheWrite + 输出×output) / 1,000,000`。
DSH 的 `inputTokens` 本身就是未命中缓存的输入，缓存命中单独记在 `cacheReadTokens`，不会重复计费。

## 兼容性

- DSH `>= 0.2.2-rc.5`
- 客户端：`conversation.composer.dock` + `conversation.chat.node` 插槽
- Host：`sessionProjections`（stateVersion 5）、`agent/pre-step`、`commands`

## 测试

```bash
cd token-budget && ./run-tests.sh            # 46 单元 + 7 真实 UI 端到端
./run-tests.sh --send                        # 额外验证超限阻断
```

每次运行都会生成 `TEST-RESULT.md`。

## 许可

MIT
