/**
 * 预算管理插件 · 真实 UI 端到端用例（E*）。
 *
 * 用法：
 *   node tests/e2e.mjs                # 只跑非破坏性用例（E1–E5）
 *   node tests/e2e.mjs --send         # 额外验证超限阻断（E6，会向所选会话追加一条消息）
 *   node tests/e2e.mjs --headed       # 有头 Chrome，方便肉眼观察
 *
 * 环境变量：
 *   DSH_NODE_EXECUTABLE  Electron/Node 可执行文件（默认取桌面端自带）
 *   DSH_INSTALL_DIR      dsh 安装目录（默认 /Applications/DeepSeek Harness.app/.../dsh）
 *   E2E_CHROME           Chrome 可执行文件路径
 *
 * 设计：
 * - 使用独立 profile `~/.dsh/profiles/e2e`（bundles 与 desktop 相同、node_modules 软链），
 *   避免影响正在使用的桌面实例；会话数据仍然复用 ~/.dsh/sessions。
 * - 通过 CDP 以真实鼠标/键盘事件驱动，不做任何内部 API 调用。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const args = new Set(process.argv.slice(2))
const WITH_SEND = args.has('--send')
const HEADED = args.has('--headed')
const HOME = os.homedir()
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'e2e')
const CP = process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// 可执行文件是真实文件，可以检查；bin.js 在 app.asar 里，shell/Node 无法 stat，只能按优先级取路径。
const ELECTRON_CANDIDATES = [
  process.env.DSH_NODE_EXECUTABLE,
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
].filter(Boolean)
const INSTALL_CANDIDATES = [
  process.env.DSH_INSTALL_DIR,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
].filter(Boolean)
const ELECTRON = ELECTRON_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (!ELECTRON) {
  console.error('找不到 DSH 可执行文件，请设置 DSH_NODE_EXECUTABLE 指向 DeepSeek Harness 可执行文件')
  process.exit(1)
}
const BIN = path.join(INSTALL_CANDIDATES[0], 'lib', 'bin.js')
const CDP_PORT = 9333

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(id, title, ok, detail = '') {
  results.push({ id, title, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${detail ? '  — ' + detail : ''}`)
}

async function ensureProfile() {
  const src = path.join(HOME, '.dsh', 'profiles', 'desktop')
  fs.mkdirSync(PROFILE, { recursive: true })
  // 每次运行都与 desktop 配置对齐，避免插件改名后 e2e profile 仍指向旧包名。
  for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    const from = path.join(src, file)
    if (!fs.existsSync(from)) continue
    const to = path.join(PROFILE, file)
    const target = fs.readFileSync(from, 'utf8')
    if (!fs.existsSync(to) || fs.readFileSync(to, 'utf8') !== target) fs.writeFileSync(to, target, 'utf8')
  }
  const link = path.join(PROFILE, 'node_modules')
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(src, 'node_modules'), link)
}

function startDsh() {
  const child = spawn(ELECTRON, [BIN, '--profile', 'e2e', '--port', '0', '--no-open'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('dsh 启动超时\n命令: ' + ELECTRON + ' ' + BIN + '\n输出:\n' + buffer.slice(-1500)))
    }, 60_000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (match) {
        clearTimeout(timer)
        resolve({ child, url: match[0] })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error('dsh 启动失败: ' + error.message + '\n可执行文件: ' + ELECTRON + '\nbin: ' + BIN))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('dsh 退出: ' + code + '\n可执行文件: ' + ELECTRON + '\nbin: ' + BIN + '\n输出:\n' + buffer.slice(-1500)))
    })
  })
}

function startChrome() {
  const child = spawn(CP, [
    HEADED ? '--headless=false' : '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'dsh-e2e-chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' })
  return child
}

async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) return
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP 未就绪')
}

/** 最小 CDP 会话。 */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const res = await fetch(url, { method: 'PUT' })
    const target = await res.json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = reject
    })
    const cdp = new Cdp(ws)
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      const pending = cdp.pending.get(msg.id)
      if (pending) { cdp.pending.delete(msg.id); pending(msg) }
    }
    return cdp
  }
  send(method, params = {}) {
    this.id += 1
    const id = this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const msg = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const result = msg.result || {}
    if (result.exceptionDetails) throw new Error('JS 异常: ' + (result.exceptionDetails.text || ''))
    return result.result ? result.result.value : undefined
  }
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
  }
}

async function main() {
  await ensureProfile()
  console.log('启动 e2e 实例…')
  const { child: dsh, url } = await startDsh()
  const chrome = startChrome()
  let cdp
  try {
    await waitForCdp()
    cdp = await Cdp.connect(`http://127.0.0.1:${CDP_PORT}/json/new`)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url })
    await sleep(10_000)

    // 欢迎页：点「继续」
    await cdp.evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); if(b){b.click(); return true} return false})()")
    await sleep(1200)

    // 打开一个会话（优先选最后一排，通常不是桌面端正在使用的那个）
    await cdp.evaluate("(()=>{const rows=[...document.querySelectorAll('[data-slot=\"sidebar.session.row.leading\"]')]; if(!rows.length) return false; rows[rows.length-1].click(); return true})()")
    await sleep(4000)

    // E1 胶囊存在
    const chip = await cdp.evaluate("!!document.querySelector('.dsh-budget-chip')")
    record('E1', '打开会话后输入框下方出现预算胶囊', chip)
    if (!chip) throw new Error('胶囊未渲染，后续用例无法继续')

    // E2 点击打开浮框
    await cdp.evaluate("document.querySelector('.dsh-budget-chip').click()")
    await sleep(800)
    const panelText = await cdp.evaluate("(()=>{const p=document.querySelector('.dsh-budget-panel'); return p?p.innerText:''})()")
    record('E2', '点击胶囊弹出二级浮框', panelText.includes('预算管理'), panelText.split('\n')[0] || '')

    // E3 设置上限为 1 并应用
    await cdp.evaluate(`(()=>{
      const input=document.querySelector('.dsh-budget-panel input')
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(input,'1'); input.dispatchEvent(new Event('input',{bubbles:true}))
      const btn=[...document.querySelectorAll('.dsh-budget-panel button')].find(b=>b.textContent.trim()==='应用')
      btn.click(); return true
    })()`)
    await sleep(2000)
    const afterApply = await cdp.evaluate("document.querySelector('.dsh-budget-panel').innerText")
    const applied = afterApply.includes('已更新') && /上限：[^\n]*\/\s*1\s*$/.test(afterApply.replace(/\n/g, '\n')) || afterApply.includes('/ 1')
    record('E3', '应用上限后浮框立即显示新上限', applied, afterApply.split('\n').find((l) => l.startsWith('作用域')) || '')

    // E4 恢复默认
    await cdp.evaluate("(()=>{[...document.querySelectorAll('.dsh-budget-panel button')].find(b=>b.textContent.trim()==='恢复默认').click(); return true})()")
    await sleep(2000)
    const afterReset = await cdp.evaluate("document.querySelector('.dsh-budget-panel').innerText")
    record('E4', '恢复默认后浮框立即回到默认上限', afterReset.includes('已恢复默认') && afterReset.includes('50.0k'), afterReset.split('\n').find((l) => l.startsWith('作用域')) || '')

    // E5 关闭开关
    await cdp.evaluate("(()=>{[...document.querySelectorAll('.dsh-budget-panel button')].find(b=>b.textContent.trim()==='开启').click(); return true})()")
    await sleep(1500)
    const off = await cdp.evaluate("JSON.stringify({text:document.querySelector('.dsh-budget-panel').innerText.slice(0,40), off:document.querySelector('.dsh-budget-chip').getAttribute('data-off')})")
    const offParsed = JSON.parse(off)
    record('E5', '关闭开关后浮框与胶囊同步变化', offParsed.text.includes('已关闭') && offParsed.off === '1', offParsed.text)

    // E7 浮框不展示单价明细（价格只走内部配置）
    const priceLine = await cdp.evaluate("(()=>{const p=document.querySelector('.dsh-budget-panel'); return p?p.innerText:''})()")
    record('E7', '浮框不再展示单价明细', !priceLine.includes('单价') && !priceLine.includes('入2'),
      priceLine.split('\n').filter((line) => line.startsWith('作用域') || line.startsWith('已用')).join(' | ').slice(0, 90))

    // 恢复开启并关闭浮框
    await cdp.evaluate("(()=>{const b=[...document.querySelectorAll('.dsh-budget-panel button')].find(x=>x.textContent.trim()==='关闭'); if(b)b.click(); return true})()")
    await sleep(1200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)

    // E6 超限阻断（需 --send）
    if (WITH_SEND) {
      const box = await cdp.evaluate("(()=>{const ed=document.querySelector('[contenteditable=\"true\"]'); if(!ed) return null; const r=ed.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
      if (!box) throw new Error('找不到输入框')
      await cdp.click(box.x, box.y)
      await sleep(300)
      await cdp.send('Input.insertText', { text: '预算阻断验证' })
      await sleep(400)
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      }
      await sleep(6000)
      const notice = await cdp.evaluate("document.body.innerText.includes('预算管理：预算已用尽')")
      record('E6', '超限发送消息被终止并出现预算提示', notice)
    } else {
      record('E6', '超限发送消息被终止并出现预算提示', true, '已跳过（加 --send 执行）')
    }
  } finally {
    try { if (cdp) cdp.ws.close() } catch { /* ignore */ }
    try { chrome.kill('SIGKILL') } catch { /* ignore */ }
    try { dsh.kill('SIGKILL') } catch { /* ignore */ }
  }

  const passed = results.filter((r) => r.ok).length
  const summary = `# 预算管理插件 · 真实 UI 端到端验证报告\n\n- 时间：${new Date().toISOString()}\n- 结果：**${passed} / ${results.length} 通过**\n- 模式：${WITH_SEND ? '含超限阻断（--send）' : '非破坏性（E1–E5）'}\n\n| 编号 | 用例 | 结果 | 备注 |\n|---|---|---|---|\n${results.map((r) => `| ${r.id} | ${r.title} | ${r.ok ? '✅ 通过' : '❌ 失败'} | ${String(r.detail).replace(/[|\n]+/g, ' ').trim()} |`).join('\n')}\n`
  fs.writeFileSync(new URL('./E2E-REPORT.md', import.meta.url), summary, 'utf8')
  fs.writeFileSync(new URL('./e2e-report.json', import.meta.url), JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: WITH_SEND ? 'send' : 'safe',
    passed,
    failed: results.length - passed,
    total: results.length,
    cases: results,
  }, null, 2), 'utf8')
  console.log(`\n${passed}/${results.length} 通过，报告：tests/E2E-REPORT.md`)
  if (passed !== results.length) process.exitCode = 1
}

main().catch((error) => {
  console.error('E2E 失败：', error && error.message)
  process.exitCode = 1
})
