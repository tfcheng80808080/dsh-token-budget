/**
 * 预算管理插件 · 一键测试入口（单元/回归 + 真实 UI 端到端）。
 *
 *   node tests/all.mjs             # 全量（含真实 UI）
 *   node tests/all.mjs --send      # 端到端包含「超限阻断」用例（会向所选会话追加一条消息）
 *   node tests/all.mjs --no-e2e    # 只跑单元/回归（无 Chrome 环境）
 *
 * 每次运行都会在项目根目录覆盖生成 TEST-RESULT.md，即使全部通过也照常产出。
 * 任一套件失败时以非零码退出。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const here = path.dirname(new URL(import.meta.url).pathname)
const pluginDir = path.resolve(here, '..')
const projectDir = path.resolve(pluginDir, '..')
const args = new Set(process.argv.slice(2))
const skipE2E = args.has('--no-e2e')
const withSend = args.has('--send')
const node = process.execPath

function runSuite(label, argv) {
  console.log(`\n===== ${label} =====`)
  const result = spawnSync(node, argv, { cwd: pluginDir, stdio: 'inherit' })
  return result.status ?? 1
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'))
  } catch {
    return null
  }
}

// 清掉上一轮结果，避免读取过期 JSON 造成「假通过」。
for (const stale of ['report.json', 'e2e-report.json', 'REPORT.md', 'E2E-REPORT.md']) {
  try { fs.unlinkSync(path.join(here, stale)) } catch { /* 不存在 */ }
}

const startedAt = new Date()
const unitCode = runSuite('单元 / 回归（tests/run.mjs）', ['tests/run.mjs'])
let e2eCode = 0
if (!skipE2E) {
  e2eCode = runSuite('真实 UI 端到端（tests/e2e.mjs）', ['tests/e2e.mjs', ...(withSend ? ['--send'] : [])])
}

const unit = readJson('report.json')
const e2e = skipE2E ? null : readJson('e2e-report.json')

const unitPassed = unit ? unit.passed : 0
const unitFailed = unit ? unit.failed : (unitCode === 0 ? 0 : 1)
const e2ePassed = e2e ? e2e.passed : 0
const e2eFailed = e2e ? e2e.failed : (skipE2E ? 0 : (e2eCode === 0 ? 0 : 1))
const totalPassed = unitPassed + e2ePassed
const totalFailed = unitFailed + e2eFailed
const ok = unitCode === 0 && e2eCode === 0 && totalFailed === 0

const cell = (value) => String(value ?? '').replace(/[|\n]+/g, ' ').trim()

const unitRows = unit
  ? unit.cases.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.ok ? '✅ 通过' : '❌ 失败'} | ${c.ms} ms |`).join('\n')
  : '| — | 单元套件未产出结果 | ❌ | — |'

const e2eRows = skipE2E
  ? '| — | 已跳过（--no-e2e） | ⏭️ | — |'
  : e2e
    ? e2e.cases.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.ok ? '✅ 通过' : '❌ 失败'} | ${cell(c.detail)} |`).join('\n')
    : '| — | 端到端套件未产出结果 | ❌ | — |'

const failures = [
  ...(unit ? unit.cases.filter((c) => !c.ok).map((c) => `${c.id} ${c.title}: ${c.error ?? ''}`) : []),
  ...(e2e ? e2e.cases.filter((c) => !c.ok).map((c) => `${c.id} ${c.title}: ${c.detail ?? ''}`) : []),
]

const report = `# 预算管理插件 · 测试结果

- 运行时间：${startedAt.toISOString()}（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）
- 运行环境：Node ${process.version} · ${os.platform()} ${os.release()}
- 运行方式：\`${skipE2E ? 'node tests/all.mjs --no-e2e' : `node tests/all.mjs${withSend ? ' --send' : ''}`}\`
- 单元 / 回归：**${unitPassed} 通过 / ${unitFailed} 失败**
- 真实 UI 端到端：${skipE2E ? '已跳过' : `**${e2ePassed} 通过 / ${e2eFailed} 失败**`}
- 总计：**${totalPassed} 通过 / ${totalFailed} 失败**
- 结论：${ok ? '✅ 全部通过' : '❌ 有失败用例，请查看下方详情'}

## 单元 / 回归（41 条）

| 编号 | 用例 | 结果 | 耗时 |
|---|---|---|---|
${unitRows}

## 真实 UI 端到端（6 条）

| 编号 | 用例 | 结果 | 备注 |
|---|---|---|---|
${e2eRows}

## 失败详情

${failures.length === 0 ? '无。' : failures.map((f) => `- ${f}`).join('\n')}

## 产物

- 明细报告：\`plugin/tests/REPORT.md\`、\`plugin/tests/E2E-REPORT.md\`
- 机器可读结果：\`plugin/tests/report.json\`、\`plugin/tests/e2e-report.json\`

> 本文件由 \`node tests/all.mjs\` 每次运行覆盖生成，请勿手工编辑。
`

const outFile = path.join(projectDir, 'TEST-RESULT.md')
fs.writeFileSync(outFile, report, 'utf8')
fs.writeFileSync(path.join(projectDir, 'test-result.json'), JSON.stringify({
  generatedAt: startedAt.toISOString(),
  ok,
  unit: { passed: unitPassed, failed: unitFailed },
  e2e: skipE2E ? { skipped: true } : { passed: e2ePassed, failed: e2eFailed },
  total: { passed: totalPassed, failed: totalFailed },
}, null, 2), 'utf8')

console.log(`\n${ok ? '✅' : '❌'} ${totalPassed} 通过 / ${totalFailed} 失败`)
console.log(`报告：${outFile}`)
if (!ok) process.exitCode = 1
