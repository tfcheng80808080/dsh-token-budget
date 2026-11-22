/**
 * 预算管理插件 · Client 侧
 *
 * 输入框下方只显示一个与背景融合的进度条胶囊（无边框、悬停有底色）；
 * 点击后弹出二级浮框，在浮框里查看明细、切换 Token / 金额、设置上限。
 */
window.__ModuleLoader__.load({
  id: '@flyman8080/dsh-token-budget',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const CSS = [
      '.dsh-budget-chip{display:inline-flex;align-items:center;gap:4px;flex:none;padding:3px 6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);line-height:20px;cursor:pointer}',
      '.dsh-budget-chip:hover,.dsh-budget-chip[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary)}',
      '.dsh-budget-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-budget-chip[data-off="1"]{opacity:.55}',
      '.dsh-budget-track{display:block;width:40px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l3,#ccc);overflow:hidden}',
      '.dsh-budget-fill{display:block;height:100%;border-radius:999px;transition:width .3s ease}',
      '.dsh-budget-label{white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-budget-over{font-size:11px;font-weight:600;color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dsh-budget-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(288px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow-y:auto;padding:12px;border:0;border-radius:12px;background:var(--dsw-specific-menu,#fff);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-budget-title{font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsh-budget-seg{display:flex;gap:4px;margin-bottom:10px}',
      '.dsh-budget-seg-btn{flex:1;padding:4px 0;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-budget-seg-btn[data-on="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dsh-budget-row{display:flex;gap:6px;margin-bottom:8px}',
      '.dsh-budget-input{flex:1;min-width:0;padding:4px 8px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsh-budget-btn{padding:4px 10px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-budget-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dsh-budget-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dsh-budget-meta{color:var(--dsw-alias-label-tertiary);margin-bottom:10px}',
      '.dsh-budget-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    ].join('')

    const C = {
      text: 'var(--dsw-alias-label-primary, #222)',
      sub: 'var(--dsw-alias-label-secondary, #666)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warn-primary, #e8a33d)',
      error: 'var(--dsw-alias-state-error-primary, #d33)',
    }

    const fmtTokens = (n) => {
      const v = Number(n) || 0
      if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T'
      if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(Math.round(v))
    }
    const fmtMoney = (n) => (Number(n) || 0).toFixed(3)

    /** 单位选项：Token 1/千/百万/十亿/万亿；金额 元/角/分。 */
    const unitOptionsFor = (isMoney) => (isMoney
      ? [['1', '元'], ['0.1', '角'], ['0.01', '分']]
      : [
        ['1', '1'],
        ['1000', '千'],
        ['1000000', '百万'],
        ['1000000000', '十亿'],
        ['1000000000000', '万亿'],
      ])

    /** 输入值 × 单位倍数。 */
    const applyUnit = (value, unit) => Number(value) * Number(unit)

    return {
      inject: ['slots', 'remote', 'remote.commands'],
      __test: { fmtTokens, fmtMoney, unitOptionsFor, applyUnit },
      apply(ctx) {
        const execute = (sessionId, line) => ctx.remote.commands.execute(sessionId, line, [])

        function BudgetChip(props) {
          const useProjection = props.useProjection
          const [open, setOpen] = React.useState(false)
          const [pos, setPos] = React.useState(null)
          const [localMode, setLocalMode] = React.useState(null)
          const [localScope, setLocalScope] = React.useState(null)
          const [localEnabled, setLocalEnabled] = React.useState(null)
          const [pendingLimit, setPendingLimit] = React.useState(null)
          const [unit, setUnit] = React.useState('1')
          const [draft, setDraft] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [msg, setMsg] = React.useState('')
          const chipRef = React.useRef(null)
          const panelRef = React.useRef(null)
          const data = typeof useProjection === 'function' ? useProjection('tokenBudget') : undefined

          React.useEffect(() => {
            if (!open) return
            const onDown = (e) => {
              const c = chipRef.current
              const p = panelRef.current
              if (c && c.contains(e.target)) return
              if (p && p.contains(e.target)) return
              setOpen(false)
            }
            const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
            document.addEventListener('pointerdown', onDown, true)
            document.addEventListener('keydown', onKey)
            return () => {
              document.removeEventListener('pointerdown', onDown, true)
              document.removeEventListener('keydown', onKey)
            }
          }, [open])

          React.useEffect(() => {
            setPendingLimit(null)
          }, [data && data.tokenLimit, data && data.moneyLimit])

          if (!data) return null

          const mode = localMode || data.mode || 'token'
          const scope = localScope || data.scope || 'session'
          const isMoney = mode === 'money'
          const isEnabled = localEnabled !== null ? localEnabled : data.enabled !== false
          const currency = data.currency || '¥'
          const sfx = scope === 'project' ? 'Project' : scope === 'task' ? 'Task' : 'Session'
          const scopedTokens = data['tokens' + sfx]
          const scopedMoney = data['money' + sfx]
          const used = isMoney
            ? (typeof scopedMoney === 'number' ? scopedMoney : data.money)
            : (typeof scopedTokens === 'number' ? scopedTokens : data.tokens)
          const baseLimit = isMoney
            ? (typeof data['moneyLimit' + sfx] === 'number' ? data['moneyLimit' + sfx] : data.moneyLimit)
            : (typeof data['tokenLimit' + sfx] === 'number' ? data['tokenLimit' + sfx] : data.tokenLimit)
          const limit = pendingLimit !== null ? pendingLimit : baseLimit
          const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
          const over = isEnabled && limit > 0 && used >= limit
          const warn = isEnabled && limit > 0 && used >= limit * 0.8
          const color = !isEnabled ? C.faint : over ? C.error : warn ? C.warn : C.brand
          const label = isMoney
            ? currency + fmtMoney(used) + ' / ' + currency + fmtMoney(limit)
            : fmtTokens(used) + ' / ' + fmtTokens(limit)
          const aria = '预算管理' + (isEnabled ? '' : '（已关闭）') + '：' + label + (over ? '（已超限）' : '')

          const toggle = () => {
            if (!open && chipRef.current) {
              const r = chipRef.current.getBoundingClientRect()
              setPos({
                left: Math.max(8, Math.min(r.left, window.innerWidth - 300)),
                bottom: window.innerHeight - r.top + 8,
              })
            }
            setOpen(!open)
          }

          const run = async (line, okText) => {
            if (busy) return null
            setBusy(true)
            setMsg('')
            try {
              const res = await execute(data.sessionId, line)
              if (res && res.ok === false) {
                setMsg((res.error && res.error.message) || '失败')
                return false
              }
              setMsg(okText)
              return true
            } catch (err) {
              setMsg(String((err && err.message) || err))
              return false
            } finally {
              setBusy(false)
            }
          }

          const unitOptions = unitOptionsFor(isMoney)
          const effectiveUnit = unit

          const applyLimit = async () => {
            const v = draft.trim()
            if (!v) return
            const n = applyUnit(v, effectiveUnit)
            if (!Number.isFinite(n) || n < 0) { setMsg('请输入有效数字'); return }
            const rounded = isMoney ? Math.round(n * 100) / 100 : Math.round(n)
            const ok = await run('/budget limit ' + rounded, '已更新')
            if (ok === true) {
              setPendingLimit(rounded)
              setDraft('')
            }
          }

          const chip = h('button', {
            ref: chipRef,
            type: 'button',
            className: 'dsh-budget-chip',
            onClick: toggle,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': aria,
            title: aria,
            'data-off': isEnabled ? '0' : '1',
          },
            h('span', { className: 'dsh-budget-label' }, '预算管理'),
            h('span', { className: 'dsh-budget-track' },
              h('span', {
                className: 'dsh-budget-fill',
                style: { width: pct + '%', background: color },
              }),
            ),
            over ? h('span', { className: 'dsh-budget-over' }, '!') : null,
          )

          const panel = open && pos ? ReactDOM.createPortal(
            h('div', {
              ref: panelRef,
              className: 'dsh-budget-panel',
              role: 'dialog',
              'aria-label': '预算管理',
              style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
            },
              h('div', { className: 'dsh-budget-title' }, '预算管理'),
              h('div', { className: 'dsh-budget-row', style: { alignItems: 'center', marginBottom: '8px' } },
                h('span', { style: { flex: 1, color: C.sub } }, isEnabled ? '已开启（超限会阻断）' : '已关闭（仅统计）'),
                h('button', {
                  type: 'button',
                  className: 'dsh-budget-seg-btn',
                  style: { flex: '0 0 64px' },
                  'data-on': isEnabled ? '1' : '0',
                  onClick: async () => {
                    const next = !isEnabled
                    setLocalEnabled(next)
                    const ok = await run('/budget ' + (next ? 'on' : 'off'), next ? '已开启' : '已关闭')
                    if (!ok) setLocalEnabled(!next)
                  },
                }, isEnabled ? '开启' : '关闭'),
              ),
              h('div', { className: 'dsh-budget-seg' },
                ['token', 'money'].map((m) => h('button', {
                  key: m,
                  type: 'button',
                  className: 'dsh-budget-seg-btn',
                  'data-on': m === mode ? '1' : '0',
                  onClick: () => { setLocalMode(m); setUnit('1'); run('/budget mode ' + m, m === 'money' ? '已切换金额模式' : '已切换 Token 模式') },
                }, m === 'money' ? '金额' : 'Token')),
              ),
              h('div', { className: 'dsh-budget-seg' },
                [['session', '会话'], ['task', '任务'], ['project', '项目']].map(([s, lb]) => h('button', {
                  key: s,
                  type: 'button',
                  className: 'dsh-budget-seg-btn',
                  'data-on': s === scope ? '1' : '0',
                  onClick: () => { setLocalScope(s); run('/budget scope ' + s, '作用域：' + lb) },
                }, lb)),
              ),
              h('div', { style: { color: C.sub } },
                '已用：' + fmtTokens(data.tokens) + ' token · ' + currency + fmtMoney(data.money)),
              h('div', { className: 'dsh-budget-meta' },
                '作用域：' + (scope === 'task' ? '任务' : scope === 'project' ? '项目' : '会话') + ' · 上限：' + label),
              h('div', { className: 'dsh-budget-row' },
                h('input', {
                  className: 'dsh-budget-input',
                  value: draft,
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') applyLimit() },
                  placeholder: isMoney ? '本次金额上限' : '本次 token 上限',
                  inputMode: 'decimal',
                }),
                h('select', {
                  className: 'dsh-budget-input',
                  style: { flex: '0 0 76px', padding: '4px 2px' },
                  value: effectiveUnit,
                  onChange: (e) => setUnit(e.target.value),
                  title: '单位',
                }, unitOptions.map(([v, lb]) => h('option', { key: v, value: v }, lb))),
                h('button', {
                  type: 'button',
                  className: 'dsh-budget-btn',
                  'data-primary': '1',
                  onClick: applyLimit,
                  disabled: busy,
                }, '应用'),
              ),
              h('div', { className: 'dsh-budget-foot' },
                h('button', {
                  type: 'button',
                  className: 'dsh-budget-btn',
                  onClick: () => {
                    const def = isMoney ? data.defaultMoneyLimit : data.defaultTokenLimit
                    if (typeof def === 'number') setPendingLimit(def)
                    run('/budget reset', '已恢复默认')
                  },
                  disabled: busy,
                }, '恢复默认'),
                msg ? h('span', { style: { color: C.faint } }, msg) : null,
              ),
            ),
            document.body,
          ) : null

          return h('span', null, h('style', null, CSS), chip, panel)
        }

        // ---- 预算终止的会话提示行 ----
        const BUDGET_STOP_REASON = 'token-budget/exhausted'

        const budgetStopDefinition = {
          kind: 'budget-stop',
          target: 'chat',
          match: (event) => {
            if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
            if (event.type === 'turn/end') {
              const r = event.data.reason
              if (r && r.kind === 'aborted' && r.reason && r.reason.kind === 'hook'
                && r.reason.reason === BUDGET_STOP_REASON) {
                return { id: String(event.data.turn), role: 'update' }
              }
            }
            return null
          },
          start: (_context, match) => ({ turn: match.event.data.turn, stopped: false, seq: 0, time: 0 }),
          update: (context, match) => ({
            ...context.state,
            stopped: true,
            seq: match.event.seq,
            time: match.event.time,
          }),
          buildViewNode: (context) => {
            const s = context.state
            if (!s || !s.stopped) return null
            const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
            return {
              key: context.key,
              kind: 'budget-stop',
              id: context.id,
              target: 'chat',
              anchorSeq: s.seq,
              location,
              visibility: 'visible',
              groupTree: 'turn',
              data: { kind: 'budget-stop', seq: s.seq, time: s.time, turn: s.turn },
            }
          },
        }

        function BudgetStopNode() {
          return h('div', {
            style: {
              margin: '6px 0',
              padding: '6px 10px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
              background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
              color: 'var(--dsw-alias-label-secondary, #666)',
              fontSize: '12px',
            },
          }, '预算管理：预算已用尽，本轮任务已终止。')
        }

        ctx.inject(['uiConversation'], (scope) => {
          scope.uiConversation.events.register(budgetStopDefinition)
          scope.slots.inject('conversation.chat.node', () => scope.slots.register({
            name: 'conversation.chat.node',
            key: 'budget-stop',
          }, BudgetStopNode))
        })

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'token-budget',
          order: 20,
        }, BudgetChip))
      },
    }
  },
})
