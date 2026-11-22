/**
 * 预算管理插件 · Host 侧
 *
 * 统计已消耗的计费 token 与金额；作用域支持 会话 / 任务 / 项目（同工作区）；
 * 达到上限时中止本轮（可在浮框内关闭阻断，仅统计）。
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'

export const name = 'token-budget'
export const inject = ['sessionProjections', 'commands', 'agents']

const SCOPES = ['session', 'task', 'project']
const MODES = ['token', 'money']

const BASE_PRICE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }

const DEFAULTS = {
  enabled: true,
  scope: 'session',
  mode: 'token',
  tokenLimit: 50000,
  moneyLimit: 10,
  currency: '¥',
  /** 未命中价目表的模型使用这张默认价（元/百万 token）。 */
  defaultPrice: { ...BASE_PRICE },
  /** 按模型 id 覆盖价目：{ input, output, cacheRead, cacheWrite }（元/百万 token）。 */
  prices: {},
  blockOnExceed: true,
}

const PriceSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
})

const ZodPrice = zod.object({
  input: zod.number(),
  output: zod.number(),
  cacheRead: zod.number(),
  cacheWrite: zod.number(),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  scope: z.string().default('session'),
  mode: z.string().default('token'),
  tokenLimit: z.number().default(50000),
  moneyLimit: z.number().default(10),
  currency: z.string().default('¥'),
  defaultPrice: PriceSchema.default({ ...BASE_PRICE }),
  prices: z.dict(PriceSchema).default({}),
  blockOnExceed: z.boolean().default(true),
})

/**
 * 归一化配置：合并默认价、按模型覆盖价，并兼容旧的扁平单价字段。
 */
function normalizeConfig(config) {
  const provided = config || {}
  const defaultPrice = { ...BASE_PRICE }
  if (provided.defaultPrice && typeof provided.defaultPrice === 'object') {
    Object.assign(defaultPrice, provided.defaultPrice)
  }
  if (typeof provided.priceInputPerMillion === 'number') defaultPrice.input = provided.priceInputPerMillion
  if (typeof provided.priceOutputPerMillion === 'number') defaultPrice.output = provided.priceOutputPerMillion
  if (typeof provided.priceCacheReadPerMillion === 'number') defaultPrice.cacheRead = provided.priceCacheReadPerMillion
  if (typeof provided.priceCacheWritePerMillion === 'number') defaultPrice.cacheWrite = provided.priceCacheWritePerMillion

  const prices = {}
  if (provided.prices && typeof provided.prices === 'object') {
    for (const [model, table] of Object.entries(provided.prices)) {
      if (!table || typeof table !== 'object') continue
      prices[model] = {
        input: Number(table.input) || 0,
        output: Number(table.output) || 0,
        cacheRead: Number(table.cacheRead) || 0,
        cacheWrite: Number(table.cacheWrite) || 0,
      }
    }
  }
  return { ...DEFAULTS, ...provided, defaultPrice, prices }
}

/**
 * 模块级运行状态：所有闭包（投影 view、pre-step 监听、命令）共用同一份，
 * 这样插件重载后旧闭包也能读到最新的开关/模式/上限。
 */
const RUNTIME = {
  cfg: null,
  enabled: true,
  mode: 'token',
  scope: 'session',
  overrides: new Map(),
  disposeAll: null,
}

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function bucketsOf(usage) {
  return {
    input: usage.inputTokens || 0,
    output: usage.outputTokens || 0,
    cacheRead: usage.cacheReadTokens || 0,
    cacheWrite: usage.cacheWriteTokens || 0,
  }
}

function sumBuckets(b) {
  return b.input + b.output + b.cacheRead + b.cacheWrite
}

function moneyOf(b, price) {
  return (
    b.input * price.input
    + b.output * price.output
    + b.cacheRead * price.cacheRead
    + b.cacheWrite * price.cacheWrite
  ) / 1e6
}

const scopeLabel = (s) => (s === 'task' ? '任务' : s === 'project' ? '项目' : '会话')

/**
 * 注册 `tokenBudget` 投影、超限阻断与 `/budget` 命令。
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const priceFor = (model) => (model && cfg.prices[model]) || cfg.defaultPrice
  // 首次加载用配置初始化；之后的重新加载保留用户运行时的开关/模式/上限。
  if (RUNTIME.cfg === null) {
    RUNTIME.enabled = cfg.enabled !== false
    RUNTIME.mode = MODES.includes(cfg.mode) ? cfg.mode : 'token'
    RUNTIME.scope = SCOPES.includes(cfg.scope) ? cfg.scope : 'session'
  }
  RUNTIME.cfg = cfg

  // 清理上一次激活留下的监听，避免旧闭包继续生效。
  if (RUNTIME.disposeAll) {
    try { RUNTIME.disposeAll() } catch (_) { /* ignore */ }
    RUNTIME.disposeAll = null
  }

  const sessionBuckets = (state) => ({
    input: state.input, output: state.output,
    cacheRead: state.cacheRead, cacheWrite: state.cacheWrite,
  })
  const turnBuckets = (state) => ({
    input: state.turnInput, output: state.turnOutput,
    cacheRead: state.turnCacheRead, cacheWrite: state.turnCacheWrite,
  })

  /** 同工作区（cwd）下所有已加载会话的累计。 */
  const projectBuckets = (state) => {
    const cwd = state.cwd
    if (!cwd) return sessionBuckets(state)
    const total = zero()
    let found = false
    let sessions = []
    try { sessions = ctx.sessions.list() } catch (_) { sessions = [] }
    for (const session of sessions) {
      if (String(session.header.cwd || '') !== cwd) continue
      let st
      try {
        st = session.id === state.sessionId ? state : handle.stateOf(session)
      } catch (_) { continue }
      if (!st) continue
      found = true
      total.input += st.input
      total.output += st.output
      total.cacheRead += st.cacheRead
      total.cacheWrite += st.cacheWrite
    }
    return found ? total : sessionBuckets(state)
  }

  const bucketsFor = (state) => {
    if (RUNTIME.scope === 'task') return turnBuckets(state)
    if (RUNTIME.scope === 'project') return projectBuckets(state)
    return sessionBuckets(state)
  }

  const limitKey = (state) => (RUNTIME.scope === 'project' ? 'project:' + state.cwd : state.sessionId)
  const overrideFor = (key) => RUNTIME.overrides.get(key) || {}
  const limitToken = (key) => {
    const v = overrideFor(key).token
    return typeof v === 'number' ? v : RUNTIME.cfg.tokenLimit
  }
  const limitMoney = (key) => {
    const v = overrideFor(key).money
    return typeof v === 'number' ? v : RUNTIME.cfg.moneyLimit
  }

  const viewOf = (state) => {
    const b = bucketsFor(state)
    const tokens = sumBuckets(b)
    const price = priceFor(state.model)
    const money = moneyOf(b, price)
    const key = limitKey(state)
    const tokenLimit = limitToken(key)
    const moneyLimit = limitMoney(key)
    const moneyMode = RUNTIME.mode === 'money'
    // 三种作用域的值同时下发，客户端切换时无需等待下一次事件刷新。
    const sB = sessionBuckets(state)
    const tB = turnBuckets(state)
    let pB = sB
    try {
      if ((ctx.sessions.list() || []).length <= 40) pB = projectBuckets(state)
    } catch (_) { pB = sB }
    return {
      sessionId: state.sessionId,
      scope: RUNTIME.scope,
      mode: RUNTIME.mode,
      enabled: RUNTIME.enabled,
      currency: RUNTIME.cfg.currency,
      tokens,
      money,
      tokenLimit,
      moneyLimit,
      used: moneyMode ? money : tokens,
      limit: moneyMode ? moneyLimit : tokenLimit,
      tokensSession: sumBuckets(sB),
      moneySession: moneyOf(sB, price),
      tokensTask: sumBuckets(tB),
      moneyTask: moneyOf(tB, price),
      tokensProject: sumBuckets(pB),
      moneyProject: moneyOf(pB, price),
      defaultTokenLimit: RUNTIME.cfg.tokenLimit,
      defaultMoneyLimit: RUNTIME.cfg.moneyLimit,
      tokenLimitSession: limitToken(state.sessionId),
      moneyLimitSession: limitMoney(state.sessionId),
      tokenLimitTask: limitToken(state.sessionId),
      moneyLimitTask: limitMoney(state.sessionId),
      tokenLimitProject: limitToken('project:' + state.cwd),
      moneyLimitProject: limitMoney('project:' + state.cwd),
      model: state.model,
      price: { ...price },
    }
  }

  const handle = await ctx.sessionProjections.register({
    key: 'tokenBudget',
    stateSchema: zod.object({
      sessionId: zod.string(),
      cwd: zod.string(),
      rev: zod.number(),
      model: zod.string(),
      input: zod.number(),
      output: zod.number(),
      cacheRead: zod.number(),
      cacheWrite: zod.number(),
      turnInput: zod.number(),
      turnOutput: zod.number(),
      turnCacheRead: zod.number(),
      turnCacheWrite: zod.number(),
    }),
    stateVersion: 5,
    init: (header) => ({
      sessionId: String(header.id),
      cwd: String(header.cwd || ''),
      rev: 0,
      model: '',
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      turnInput: 0, turnOutput: 0, turnCacheRead: 0, turnCacheWrite: 0,
    }),
    apply: (state, event) => {
      if (!event || !event.type) return state
      // 命令生命周期事件会写入会话日志；借此让视图重新发布，
      // 使 /budget 修改上限/模式/作用域后客户端立即刷新。
      if (event.type === 'command/done') {
        return { ...state, rev: (state.rev || 0) + 1 }
      }
      if (event.type === 'model/selection') {
        const model = event.data && event.data.model
        return typeof model === 'string' && model !== state.model ? { ...state, model } : state
      }
      if (event.type === 'request/header') {
        const config = event.data && event.data.header && event.data.header.config
        const model = config && config.model
        return typeof model === 'string' && model !== state.model ? { ...state, model } : state
      }
      if (event.type === 'turn/start') {
        const zeroTurn = state.turnInput === 0 && state.turnOutput === 0
          && state.turnCacheRead === 0 && state.turnCacheWrite === 0
        return zeroTurn ? state : {
          ...state,
          turnInput: 0, turnOutput: 0, turnCacheRead: 0, turnCacheWrite: 0,
        }
      }
      if (event.type === 'assistant/message') {
        const usage = event.data && event.data.usage
        if (!usage) return state
        const b = bucketsOf(usage)
        if (sumBuckets(b) <= 0) return state
        return {
          ...state,
          input: state.input + b.input,
          output: state.output + b.output,
          cacheRead: state.cacheRead + b.cacheRead,
          cacheWrite: state.cacheWrite + b.cacheWrite,
          turnInput: state.turnInput + b.input,
          turnOutput: state.turnOutput + b.output,
          turnCacheRead: state.turnCacheRead + b.cacheRead,
          turnCacheWrite: state.turnCacheWrite + b.cacheWrite,
        }
      }
      return state
    },
    wire: {
      viewSchema: zod.object({
        sessionId: zod.string(),
        scope: zod.string(),
        mode: zod.string(),
        enabled: zod.boolean(),
        currency: zod.string(),
        tokens: zod.number(),
        money: zod.number(),
        tokenLimit: zod.number(),
        moneyLimit: zod.number(),
        used: zod.number(),
        limit: zod.number(),
        tokensSession: zod.number(),
        moneySession: zod.number(),
        tokensTask: zod.number(),
        moneyTask: zod.number(),
        tokensProject: zod.number(),
        moneyProject: zod.number(),
        defaultTokenLimit: zod.number(),
        defaultMoneyLimit: zod.number(),
        tokenLimitSession: zod.number(),
        moneyLimitSession: zod.number(),
        tokenLimitTask: zod.number(),
        moneyLimitTask: zod.number(),
        tokenLimitProject: zod.number(),
        moneyLimitProject: zod.number(),
        model: zod.string(),
        price: ZodPrice,
      }),
      view: viewOf,
    },
  })

  // 每个 agent 的 pre-step 检查：超限则中止本轮（turn/end 记录 hook 原因）。
  const disposers = []
  const attached = new Set()

  const attach = (agent) => {
    if (!agent || attached.has(agent.id)) return
    attached.add(agent.id)
    const dispose = agent.ctx.on('agent/pre-step', async (step, next) => {
      const decision = await next()
      if (!decision || decision.kind === 'reject') return decision
      // 每次都读共享状态：关闭阻断、或切换作用域后立即生效。
      if (!RUNTIME.enabled || !RUNTIME.cfg.blockOnExceed) return decision
      let view
      try { view = viewOf(handle.stateOf(agent.session)) } catch (_) { return decision }
      if (view.limit > 0 && view.used >= view.limit) {
        try { agent.cancel({ kind: 'hook', reason: 'token-budget/exhausted' }) } catch (_) { /* ignore */ }
      }
      return decision
    })
    disposers.push(dispose)
  }

  RUNTIME.disposeAll = () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch (_) { /* ignore */ }
    }
  }

  ctx.effect(() => () => {
    if (RUNTIME.disposeAll) {
      try { RUNTIME.disposeAll() } catch (_) { /* ignore */ }
      RUNTIME.disposeAll = null
    }
  })

  ctx.on('agent/created', (payload) => attach(payload && payload.agent))

  // 对启用前已存在的 agent 也挂载（否则旧会话不会触发阻断）。
  try {
    for (const agent of ctx.agents.list()) attach(agent)
  } catch (_) { /* ignore */ }

  const handleCommand = (invocation) => {
    const sid = invocation.agent.session.id
    const raw = String(invocation.rawInput || '').trim()
    const parts = raw.split(/\s+/).filter(Boolean)
    const sub = (parts[0] || 'show').toLowerCase()
    const arg = parts[1]

    if (sub === 'show' || sub === '') {
      const view = viewOf(handle.stateOf(invocation.agent.session))
      const usedText = RUNTIME.mode === 'money'
        ? RUNTIME.cfg.currency + view.money.toFixed(4)
        : String(view.tokens)
      const limitText = RUNTIME.mode === 'money'
        ? RUNTIME.cfg.currency + view.moneyLimit
        : String(view.tokenLimit)
      return {
        kind: 'success',
        text: `${RUNTIME.enabled ? '' : '[已关闭] '}预算(${RUNTIME.mode === 'money' ? '金额' : 'Token'} / ${scopeLabel(RUNTIME.scope)})：已用 ${usedText} / 上限 ${limitText}；Token ${view.tokens}，金额 ${RUNTIME.cfg.currency}${view.money.toFixed(4)}`,
      }
    }
    if (sub === 'on' || sub === 'off') {
      RUNTIME.enabled = sub === 'on'
      return { kind: 'success', text: RUNTIME.enabled ? '预算已开启（超限会阻断）' : '预算已关闭（仅统计，不阻断）' }
    }
    if (sub === 'mode') {
      if (!MODES.includes(arg)) return { kind: 'error', text: '用法：/budget mode token|money' }
      RUNTIME.mode = arg
      return { kind: 'success', text: `预算模式切换为 ${arg === 'money' ? '金额' : 'Token'}` }
    }
    if (sub === 'scope') {
      if (!SCOPES.includes(arg)) return { kind: 'error', text: '用法：/budget scope session|task|project' }
      RUNTIME.scope = arg
      return { kind: 'success', text: `预算作用域切换为 ${scopeLabel(RUNTIME.scope)}` }
    }
    if (sub === 'limit') {
      const n = Number(arg)
      if (!Number.isFinite(n) || n < 0) return { kind: 'error', text: '用法：/budget limit <非负数字>' }
      const key = RUNTIME.scope === 'project'
        ? 'project:' + String(invocation.agent.session.header.cwd || '')
        : sid
      const current = overrideFor(key)
      RUNTIME.overrides.set(key, { ...current, [RUNTIME.mode]: n })
      return { kind: 'success', text: `${RUNTIME.mode === 'money' ? '金额' : 'Token'}上限已设为 ${n}` }
    }
    if (sub === 'reset') {
      const key = RUNTIME.scope === 'project'
        ? 'project:' + String(invocation.agent.session.header.cwd || '')
        : sid
      RUNTIME.overrides.delete(key)
      return { kind: 'success', text: '已恢复全局默认预算' }
    }
    return { kind: 'error', text: '用法：/budget [on|off|show|mode token|money|scope session|task|project|limit <n>|reset]' }
  }

  ctx.commands.register({
    name: 'budget',
    description: 'Manage the token/money budget for this session, task, or project.',
    input: { hint: 'on|off | show | mode token|money | scope session|task|project | limit <n> | reset' },
    handler: handleCommand,
  })

  ctx.commands.register({
    name: 'tokenbudget',
    description: 'Alias of /budget.',
    input: { hint: 'on|off | show | mode token|money | scope session|task|project | limit <n> | reset' },
    handler: handleCommand,
  })
}
