/**
 * 预算管理插件 · Client 回归用例（C*）。
 * 用桩替代 react / react-dom，校验插槽注册、会话提示节点与单位换算。
 */
import fs from 'node:fs'
import { assert, eq, near } from './harness.mjs'

const SRC = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
}

const ReactDOM = { createPortal: (node) => node }

function loadClient() {
  const registered = { slots: {}, definition: null, comp: null }
  const slots = {
    inject: (_key, cb) => cb(),
    register: (options, Component) => {
      const key = options.name + (options.key ? '/' + options.key : '')
      registered.slots[key] = options
      registered.comp = Component
      return () => {}
    },
  }
  const ctx = {
    slots,
    remote: { commands: { execute: async () => ({ ok: true }) } },
    effect: (cb) => { cb(); return () => {} },
    inject: (_services, cb) => cb({
      slots,
      uiConversation: { events: { register: (def) => { registered.definition = def } } },
    }),
  }
  let mod
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        mod = factory((specifier) => {
          if (specifier === 'react') return React
          if (specifier === 'react-dom') return ReactDOM
          throw new Error('unexpected require: ' + specifier)
        })
        mod.apply(ctx)
      },
    },
  }
  eval(SRC)
  return { registered, mod }
}

const STOP = { kind: 'aborted', reason: { kind: 'hook', reason: 'token-budget/exhausted' } }

export default async function register(test) {
  test('C1', '注册输入框下方 dock 胶囊', async () => {
    const { registered } = loadClient()
    assert(registered.slots['conversation.composer.dock'], 'dock 未注册')
    eq(registered.slots['conversation.composer.dock'].id, 'token-budget')
  })

  test('C2', '注册 budget-stop 会话提示渲染器', async () => {
    const { registered } = loadClient()
    assert(registered.slots['conversation.chat.node/budget-stop'], 'chat node 未注册')
  })

  test('C3', '会话节点定义为 chat 目标', async () => {
    const { registered } = loadClient()
    const def = registered.definition
    assert(def, '定义未注册')
    eq(def.kind, 'budget-stop')
    eq(def.target, 'chat')
  })

  test('C4', 'turn/start 触发 start', async () => {
    const { registered } = loadClient()
    const match = registered.definition.match({ type: 'turn/start', data: { turn: 3 } })
    eq(match, { id: '3', role: 'start' })
  })

  test('C5', '预算中止的 turn/end 触发 update', async () => {
    const { registered } = loadClient()
    const match = registered.definition.match({ type: 'turn/end', data: { turn: 3, reason: STOP } })
    eq(match, { id: '3', role: 'update' })
  })

  test('C6', '其他结束原因不触发提示', async () => {
    const { registered } = loadClient()
    const def = registered.definition
    eq(def.match({ type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } }), null, 'blocked')
    eq(def.match({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'other' } } },
    }), null, '其他 hook 原因')
    eq(def.match({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), null, 'completed')
  })

  test('C7', '仅在终止后生成视图节点', async () => {
    const { registered } = loadClient()
    const def = registered.definition
    const base = { key: 'k', id: 'i', start: null, matches: [] }
    eq(def.buildViewNode({ ...base, state: { turn: 1, stopped: false } }), null, '未终止时为 null')
    const start = def.start({}, { event: { type: 'turn/start', data: { turn: 1 } } })
    const stopped = def.update({ state: start }, { event: { type: 'turn/end', data: { turn: 1, reason: STOP }, seq: 12, time: 99 } })
    eq(stopped.stopped, true)
    eq(stopped.seq, 12)
    const node = def.buildViewNode({ ...base, state: stopped })
    assert(node, '应生成节点')
    eq(node.kind, 'budget-stop')
    eq(node.target, 'chat')
    eq(node.anchorSeq, 12)
    eq(node.visibility, 'visible')
  })

  test('C8', 'token 数值格式化支持 k/M/B/T', async () => {
    const { mod } = loadClient()
    const f = mod.__test.fmtTokens
    eq(f(999), '999')
    eq(f(1500), '1.5k')
    eq(f(2_500_000), '2.5M')
    eq(f(1_200_000_000), '1.2B')
    eq(f(3_000_000_000_000), '3.0T')
  })

  test('C9', '金额格式化为三位小数', async () => {
    const { mod } = loadClient()
    const f = mod.__test.fmtMoney
    eq(f(0.01105), '0.011')
    eq(f(10), '10.000')
    eq(f(undefined), '0.000')
  })

  test('C10', 'Token 单位含 1/千/百万/十亿/万亿', async () => {
    const { mod } = loadClient()
    const options = mod.__test.unitOptionsFor(false)
    eq(options.map((o) => o[1]), ['1', '千', '百万', '十亿', '万亿'])
    eq(options.map((o) => Number(o[0])), [1, 1e3, 1e6, 1e9, 1e12])
  })

  test('C11', '金额单位含 元/角/分', async () => {
    const { mod } = loadClient()
    const options = mod.__test.unitOptionsFor(true)
    eq(options.map((o) => o[1]), ['元', '角', '分'])
    near(Number(options[1][0]), 0.1, 1e-12)
    near(Number(options[2][0]), 0.01, 1e-12)
  })

  test('C12', '单位换算：输入值 × 倍数', async () => {
    const { mod } = loadClient()
    const applyUnit = mod.__test.applyUnit
    eq(applyUnit('50', '1000'), 50000)
    eq(applyUnit('1.5', '1000000'), 1500000)
    eq(applyUnit('5', '0.1'), 0.5)
    eq(applyUnit('7', '0.01'), 0.07)
  })
}
