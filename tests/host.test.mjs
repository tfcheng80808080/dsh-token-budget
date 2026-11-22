/**
 * 预算管理插件 · Host 回归用例（H*）。
 * 每个用例使用全新模块实例，覆盖投影、视图、命令、阻断与重载行为。
 */
import {
  assert, eq, near, freshHost, makeCtx, makeAgent, makeSession, emptyState,
} from './harness.mjs'

const viewOf = (def, state, ctx) => def.wire.viewSchema.parse(def.wire.view(state))

const budgetCmd = (captured) => captured.cmds.find((c) => c.name === 'budget')

const runCmd = (captured, agent, rawInput) => budgetCmd(captured).handler({ agent, rawInput })
  ?? null

const enterNext = async () => ({ kind: 'enter', messages: [] })

export default async function register(test) {
  // ---------- 配置与 schema ----------

  test('H1', '未传配置时使用默认值', async () => {
    const { apply } = await freshHost('H1')
    const { ctx, captured } = makeCtx()
    await apply(ctx, undefined)
    const state = captured.def.init({ id: 's1', cwd: '/proj' })
    const view = viewOf(captured.def, state)
    eq(view.tokenLimit, 50000, 'tokenLimit')
    eq(view.moneyLimit, 10, 'moneyLimit')
    eq(view.currency, '¥', 'currency')
    eq(view.mode, 'token', 'mode')
    eq(view.scope, 'session', 'scope')
    eq(view.enabled, true, 'enabled')
  })

  test('H2', 'stateSchema 为 zod 且能解析初始状态', async () => {
    const { apply } = await freshHost('H2')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    eq(typeof def.stateSchema.parse, 'function', 'stateSchema.parse 必须存在')
    const state = def.init({ id: 's1', cwd: '/proj' })
    eq(def.stateSchema.parse(state), state)
    eq(def.stateVersion, 5, 'stateVersion')
  })

  test('H3', 'viewSchema 为 zod 且覆盖全部下发字段', async () => {
    const { apply } = await freshHost('H3')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    eq(typeof def.wire.viewSchema.parse, 'function', 'viewSchema.parse 必须存在')
    const view = viewOf(def, emptyState())
    const required = [
      'sessionId', 'scope', 'mode', 'enabled', 'currency', 'tokens', 'money',
      'tokenLimit', 'moneyLimit', 'used', 'limit',
      'tokensSession', 'moneySession', 'tokensTask', 'moneyTask',
      'tokensProject', 'moneyProject', 'defaultTokenLimit', 'defaultMoneyLimit',
      'tokenLimitSession', 'moneyLimitSession', 'tokenLimitTask', 'moneyLimitTask',
      'tokenLimitProject', 'moneyLimitProject', 'model', 'price',
    ]
    for (const key of required) {
      assert(key in view, `view 缺少字段 ${key}`)
    }
  })

  // ---------- 事件折叠 ----------

  test('H4', 'assistant/message 累计四类 token', async () => {
    const { apply } = await freshHost('H4')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 50 } },
    })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    })
    eq([state.input, state.output, state.cacheRead, state.cacheWrite], [3000, 500, 500, 50])
    eq([state.turnInput, state.turnOutput], [3000, 500])
  })

  test('H5', '无 usage 或零用量的消息不改变状态', async () => {
    const { apply } = await freshHost('H5')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const state = def.init({ id: 's1', cwd: '/proj' })
    eq(def.apply(state, { type: 'assistant/message', data: {} }), state)
    eq(def.apply(state, { type: 'assistant/message', data: { usage: { inputTokens: 0 } } }), state)
  })

  test('H6', 'turn/start 清零本轮累计、保留会话累计', async () => {
    const { apply } = await freshHost('H6')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, { type: 'assistant/message', data: { usage: { inputTokens: 100 } } })
    state = def.apply(state, { type: 'turn/start', data: {} })
    eq(state.turnInput, 0, '本轮清零')
    eq(state.input, 100, '会话保留')
  })

  test('H7', 'command/done 递增 rev 以触发视图重发', async () => {
    const { apply } = await freshHost('H7')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const state = def.init({ id: 's1', cwd: '/proj' })
    const next = def.apply(state, { type: 'command/done', data: { kind: 'success' } })
    assert(next !== state, '必须返回新对象')
    eq(next.rev, 1, 'rev')
    eq(def.apply(next, { type: 'command/done', data: {} }).rev, 2, 'rev 递增')
  })

  // ---------- 视图计算 ----------

  test('H8', 'Token 模式下 used/limit 取 token 口径', async () => {
    const { apply } = await freshHost('H8')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, { type: 'assistant/message', data: { usage: { inputTokens: 1234, outputTokens: 11 } } })
    const view = viewOf(def, state)
    eq(view.used, 1245, 'used')
    eq(view.limit, 50000, 'limit')
  })

  test('H9', '金额模式下 used/limit 取金额口径', async () => {
    const { apply } = await freshHost('H9')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 100 } } })
    runCmd(captured, { session: { id: 's1', header: { cwd: '/proj' } } }, 'mode money')
    const view = viewOf(def, state)
    near(view.used, view.money, 1e-12, 'used = money')
    eq(view.limit, view.moneyLimit, 'limit = moneyLimit')
    eq(view.mode, 'money')
  })

  test('H10', '金额换算 = 各桶 token × 单价 / 1e6', async () => {
    const { apply } = await freshHost('H10')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 } },
    })
    const view = viewOf(def, state)
    near(view.money, (1000 * 2 + 100 * 8 + 500 * 0.5) / 1e6, 1e-12, 'money')
  })

  test('H11', '三种作用域的 token 同时下发', async () => {
    const { apply } = await freshHost('H11')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const state = emptyState()
    state.input = 1000; state.output = 100
    state.turnInput = 100; state.turnOutput = 10
    const view = viewOf(def, state)
    eq(view.tokensSession, 1100, '会话')
    eq(view.tokensTask, 110, '任务')
    eq(view.tokensProject, 1100, '项目（无其他会话时等于会话）')
  })

  test('H12', '项目作用域只聚合同 cwd 的已加载会话', async () => {
    const { apply } = await freshHost('H12')
    const self = makeSession('s1', '/proj')
    const sibling = makeSession('s2', '/proj')
    const other = makeSession('s3', '/other')
    const { ctx, captured } = makeCtx({ sessions: [self, sibling, other] })
    await apply(ctx, {})
    const def = captured.def
    const state = emptyState('s1', '/proj')
    state.input = 1000
    captured.states.set('s2', { ...emptyState('s2', '/proj'), input: 500 })
    captured.states.set('s3', { ...emptyState('s3', '/other'), input: 900 })
    const view = viewOf(def, state)
    eq(view.tokensProject, 1500, '项目 = 本会话 1000 + 同 cwd 500')
  })

  test('H13', '会话上限覆盖不影响项目上限', async () => {
    const { apply } = await freshHost('H13')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const state = emptyState()
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'limit 777')
    const view = viewOf(def, state)
    eq(view.tokenLimitSession, 777, '会话上限')
    eq(view.tokenLimitProject, 50000, '项目上限保持默认')
  })

  test('H14', '项目作用域上限按工作区共享', async () => {
    const { apply } = await freshHost('H14')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'scope project')
    runCmd(captured, agent, 'limit 888')
    const view = viewOf(def, emptyState())
    eq(view.tokenLimitProject, 888, '项目上限')
    runCmd(captured, agent, 'scope session')
    const back = viewOf(def, emptyState())
    eq(back.tokenLimitSession, 50000, '切回会话后回到默认')
  })

  // ---------- 命令 ----------

  test('H15', '/budget show 返回用量与上限', async () => {
    const { apply } = await freshHost('H15')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    captured.current = emptyState()
    const result = runCmd(captured, { session: { id: 's1', header: { cwd: '/proj' } } }, 'show')
    assert(result && result.kind === 'success', '应成功')
    assert(result.text.includes('已用'), '应包含已用')
    assert(result.text.includes('上限'), '应包含上限')
  })

  test('H16', 'on/off 切换阻断开关', async () => {
    const { apply } = await freshHost('H16')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'off')
    eq(viewOf(def, emptyState()).enabled, false, 'off')
    runCmd(captured, agent, 'on')
    eq(viewOf(def, emptyState()).enabled, true, 'on')
  })

  test('H17', 'mode 切换 token/money 并拒绝非法值', async () => {
    const { apply } = await freshHost('H17')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'mode money')
    eq(viewOf(def, emptyState()).mode, 'money')
    eq(runCmd(captured, agent, 'mode nope').kind, 'error', '非法模式')
  })

  test('H18', 'scope 切换并拒绝非法值', async () => {
    const { apply } = await freshHost('H18')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    for (const scope of ['task', 'project', 'session']) {
      runCmd(captured, agent, 'scope ' + scope)
      eq(viewOf(def, emptyState()).scope, scope)
    }
    eq(runCmd(captured, agent, 'scope nope').kind, 'error', '非法作用域')
  })

  test('H19', 'limit 按当前口径写入覆盖值', async () => {
    const { apply } = await freshHost('H19')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'limit 123456')
    eq(viewOf(def, emptyState()).tokenLimit, 123456)
    runCmd(captured, agent, 'mode money')
    runCmd(captured, agent, 'limit 0.5')
    eq(viewOf(def, emptyState()).moneyLimit, 0.5)
  })

  test('H20', 'reset 清除覆盖值', async () => {
    const { apply } = await freshHost('H20')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    runCmd(captured, agent, 'limit 999')
    runCmd(captured, agent, 'reset')
    eq(viewOf(def, emptyState()).tokenLimit, 50000, '回到默认')
  })

  test('H21', '非法 limit 参数返回错误且不改状态', async () => {
    const { apply } = await freshHost('H21')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    const agent = { session: { id: 's1', header: { cwd: '/proj' } } }
    eq(runCmd(captured, agent, 'limit -1').kind, 'error')
    eq(runCmd(captured, agent, 'limit abc').kind, 'error')
    eq(viewOf(def, emptyState()).tokenLimit, 50000)
  })

  // ---------- 阻断 ----------

  test('H22', '超限且开启时以 hook 原因中止本轮', async () => {
    const { apply } = await freshHost('H22')
    const agent = makeAgent('s1')
    const { ctx, captured } = makeCtx({ agents: [agent] })
    await apply(ctx, {})
    captured.current = { ...emptyState(), input: 200000, turnInput: 200000 }
    assert(agent.listeners.length === 1, '应挂载一个 pre-step 监听')
    await agent.listeners[0]({}, enterNext)
    eq(agent.cancels.length, 1, '应 cancel 一次')
    eq(agent.cancels[0], { kind: 'hook', reason: 'token-budget/exhausted' })
  })

  test('H23', '关闭阻断后超限也不中止', async () => {
    const { apply } = await freshHost('H23')
    const agent = makeAgent('s1')
    const { ctx, captured } = makeCtx({ agents: [agent] })
    await apply(ctx, {})
    captured.current = { ...emptyState(), input: 200000, turnInput: 200000 }
    runCmd(captured, { session: { id: 's1', header: { cwd: '/proj' } } }, 'off')
    await agent.listeners[0]({}, enterNext)
    eq(agent.cancels.length, 0, '不应 cancel')
  })

  test('H24', '未超限时不中止', async () => {
    const { apply } = await freshHost('H24')
    const agent = makeAgent('s1')
    const { ctx, captured } = makeCtx({ agents: [agent] })
    await apply(ctx, {})
    captured.current = { ...emptyState(), input: 100, turnInput: 100 }
    await agent.listeners[0]({}, enterNext)
    eq(agent.cancels.length, 0)
  })

  test('H25', 'blockOnExceed=false 时不中止', async () => {
    const { apply } = await freshHost('H25')
    const agent = makeAgent('s1')
    const { ctx, captured } = makeCtx({ agents: [agent] })
    await apply(ctx, { blockOnExceed: false })
    captured.current = { ...emptyState(), input: 200000, turnInput: 200000 }
    await agent.listeners[0]({}, enterNext)
    eq(agent.cancels.length, 0)
  })

  test('H26', '对启用前已存在的 agent 也挂载监听', async () => {
    const { apply } = await freshHost('H26')
    const existing = makeAgent('s1')
    const { ctx } = makeCtx({ agents: [existing] })
    await apply(ctx, {})
    eq(existing.listeners.length, 1, '既有 agent 应被挂载')
  })

  test('H27', '重复激活不重复挂载同一 agent', async () => {
    const { apply } = await freshHost('H27')
    const agent = makeAgent('s1')
    const { ctx } = makeCtx({ agents: [agent] })
    await apply(ctx, {})
    await apply(ctx, {})
    eq(agent.listeners.length, 1, '应只保留一个监听')
  })

  test('H28', '重复激活后旧闭包读取共享开关', async () => {
    const { apply } = await freshHost('H28')
    const agent = makeAgent('s1')
    const { ctx, captured } = makeCtx({ agents: [agent] })
    await apply(ctx, {})
    const staleListener = agent.listeners[0]
    await apply(ctx, {})
    captured.current = { ...emptyState(), input: 200000, turnInput: 200000 }
    runCmd(captured, { session: { id: 's1', header: { cwd: '/proj' } } }, 'off')
    await staleListener({}, enterNext)
    eq(agent.cancels.length, 0, '旧监听也必须读到已关闭')
  })

  // ---------- 按模型计价 ----------

  test('H30', 'model/selection 事件记录当前模型', async () => {
    const { apply } = await freshHost('H30')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    eq(state.model, '', '初始为空')
    state = def.apply(state, { type: 'model/selection', data: { model: 'm2', provider: 'p' } })
    eq(state.model, 'm2')
    eq(viewOf(def, state).model, 'm2')
  })

  test('H31', '命中模型价目表时按该模型单价计费', async () => {
    const { apply } = await freshHost('H31')
    const { ctx, captured } = makeCtx()
    await apply(ctx, { prices: { m2: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 } } })
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, { type: 'model/selection', data: { model: 'm2' } })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 } },
    })
    near(viewOf(def, state).money, (1000 * 10 + 100 * 20 + 500 * 1) / 1e6, 1e-12, 'm2 计价')
  })

  test('H32', '未登记模型回落到默认价目表', async () => {
    const { apply } = await freshHost('H32')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {
      defaultPrice: { input: 3, output: 9, cacheRead: 1, cacheWrite: 3 },
      prices: { other: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 } },
    })
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, { type: 'model/selection', data: { model: 'unknown-model' } })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 } },
    })
    const view = viewOf(def, state)
    near(view.money, (1000 * 3 + 100 * 9 + 500 * 1) / 1e6, 1e-12, '默认价')
    eq(view.price, { input: 3, output: 9, cacheRead: 1, cacheWrite: 3 })
  })

  test('H34', 'request/header 也能更新当前模型', async () => {
    const { apply } = await freshHost('H34')
    const { ctx, captured } = makeCtx()
    await apply(ctx, { prices: { 'v4-pro': { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 } } })
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, {
      type: 'request/header',
      data: { header: { config: { provider: 'deepseek', model: 'v4-pro' } } },
    })
    eq(state.model, 'v4-pro')
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000000 } },
    })
    near(viewOf(def, state).money, 4, 1e-9, '100 万输入 × 4 元')
  })

  test('H33', '旧扁平单价字段仍被兼容', async () => {
    const { apply } = await freshHost('H33')
    const { ctx, captured } = makeCtx()
    await apply(ctx, { priceInputPerMillion: 7 })
    const def = captured.def
    let state = def.init({ id: 's1', cwd: '/proj' })
    state = def.apply(state, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1000000 } },
    })
    near(viewOf(def, state).money, 7, 1e-9, '100 万 token × 7 元')
  })

  test('H29', '同时注册 budget 与 tokenbudget 别名', async () => {
    const { apply } = await freshHost('H29')
    const { ctx, captured } = makeCtx()
    await apply(ctx, {})
    assert(captured.cmds.some((c) => c.name === 'budget'), 'budget')
    assert(captured.cmds.some((c) => c.name === 'tokenbudget'), 'tokenbudget')
  })
}
