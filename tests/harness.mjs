/**
 * 预算管理插件测试基座：零依赖的极简断言与 Host/Client 双子。
 * 每个用例都通过 `freshHost()` 以查询串破坏 ESM 缓存，拿到全新的模块级状态。
 */

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg ? msg + ': ' : ''}expected ${b}, got ${a}`)
}

export function near(actual, expected, eps = 1e-9, msg) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ~${expected} (±${eps}), got ${actual}`)
  }
}

/** 取一份全新的 Host 模块（模块级 RUNTIME 也随之重置）。 */
export function freshHost(caseId) {
  const url = new URL('../index.js?case=' + encodeURIComponent(caseId), import.meta.url).href
  return import(url)
}

/**
 * 构造最小的 Host Context。
 * @param options.sessions - `ctx.sessions.list()` 的返回（项目作用域聚合用）
 * @param options.agents - `ctx.agents.list()` 的返回（挂载既有 agent 用）
 */
export function makeCtx({ sessions = [], agents = [] } = {}) {
  const captured = {
    def: null,
    cmds: [],
    ons: [],
    effects: [],
    /** sessionId -> state；未命中时回退 current */
    states: new Map(),
    current: null,
  }
  const handle = {
    stateOf: (session) => captured.states.get(session.id) ?? captured.current,
  }
  const ctx = {
    sessionProjections: {
      register: async (def) => { captured.def = def; return handle },
    },
    commands: { register: (def) => { captured.cmds.push(def) } },
    on: (event, fn) => { captured.ons.push({ event, fn }); return () => {} },
    effect: (cb) => { captured.effects.push(cb()); return () => {} },
    agents: { list: () => agents },
    sessions: { list: () => sessions },
  }
  return { ctx, captured, handle }
}

/** 构造一个 Session 桩（`ctx.sessions.list()` 的元素）。 */
export function makeSession(id, cwd = '/proj') {
  return { id, header: { id, cwd } }
}

/** 构造一个可被 pre-step 拦截的 agent。 */
export function makeAgent(id, cwd = '/proj') {
  const agent = {
    id,
    session: { id, header: { cwd } },
    cancels: [],
    listeners: [],
  }
  agent.ctx = {
    on: (event, fn) => {
      if (event !== 'agent/pre-step') return () => {}
      agent.listeners.push(fn)
      return () => {
        const index = agent.listeners.indexOf(fn)
        if (index >= 0) agent.listeners.splice(index, 1)
      }
    },
  }
  agent.cancel = (cause) => { agent.cancels.push(cause) }
  return agent
}

/** 一份空状态。 */
export function emptyState(id = 's1', cwd = '/proj') {
  return {
    sessionId: id,
    cwd,
    rev: 0,
    model: '',
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    turnInput: 0, turnOutput: 0, turnCacheRead: 0, turnCacheWrite: 0,
  }
}

/** 直接喂一条 assistant/message 用量。 */
export function withUsage(state, usage) {
  return {
    input: state.input + (usage.inputTokens || 0),
    output: state.output + (usage.outputTokens || 0),
    cacheRead: state.cacheRead + (usage.cacheReadTokens || 0),
    cacheWrite: state.cacheWrite + (usage.cacheWriteTokens || 0),
    turnInput: state.turnInput + (usage.inputTokens || 0),
    turnOutput: state.turnOutput + (usage.outputTokens || 0),
    turnCacheRead: state.turnCacheRead + (usage.cacheReadTokens || 0),
    turnCacheWrite: state.turnCacheWrite + (usage.cacheWriteTokens || 0),
  }
}
