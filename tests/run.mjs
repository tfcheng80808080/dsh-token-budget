/**
 * 预算管理插件回归测试入口：`node tests/run.mjs`
 * 运行 Host / Client 全部用例，生成 tests/REPORT.md，失败时以非零码退出。
 */
import fs from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import hostTests from './host.test.mjs'
import clientTests from './client.test.mjs'

const cases = []
const test = (id, title, fn) => {
  const group = id.startsWith('H') ? 'Host' : id.startsWith('C') ? 'Client' : '其他'
  cases.push({ group, id, title, fn })
}

await hostTests(test)
await clientTests(test)

const startedAt = new Date()
const rows = []

for (const testCase of cases) {
  const start = Date.now()
  try {
    await testCase.fn()
    rows.push({ ...testCase, ok: true, ms: Date.now() - start })
    console.log(`PASS  ${testCase.id}  ${testCase.title}`)
  } catch (error) {
    rows.push({ ...testCase, ok: false, ms: Date.now() - start, error: String((error && error.stack) || error) })
    console.log(`FAIL  ${testCase.id}  ${testCase.title}`)
    console.log('      ' + String((error && error.message) || error).split('\n')[0])
  }
}

const passed = rows.filter((row) => row.ok).length
const failed = rows.length - passed
const duration = Date.now() - startedAt.getTime()

const escapeCell = (value) => String(value).replace(/\|/g, '\\|')
const table = rows
  .map((row) => `| ${row.group} | ${row.id} | ${escapeCell(row.title)} | ${row.ok ? '✅ 通过' : '❌ 失败'} | ${row.ms} ms |`)
  .join('\n')

const failures = rows.filter((row) => !row.ok)
const failureDetails = failures.length === 0
  ? ''
  : `\n## 失败详情\n\n${failures.map((row) => `### ${row.id} ${row.title}\n\n\`\`\`\n${row.error}\n\`\`\`\n`).join('\n')}`

const report = `# 预算管理插件 · 回归验证报告

- 生成时间：${startedAt.toISOString()}（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）
- 运行环境：Node ${process.version} · ${os.platform()} ${os.release()}
- 运行命令：\`node tests/run.mjs\`
- 结果：**${passed} 通过 / ${failed} 失败 / 共 ${rows.length} 条**（耗时 ${duration} ms）

## 用例结果

| 分组 | 编号 | 用例 | 结果 | 耗时 |
|---|---|---|---|---|
${table}
${failureDetails}
## 说明

- Host 用例每条都以查询串重新导入 \`index.js\`，因此模块级 \`RUNTIME\` 状态互不污染。
- Client 用例以桩替代 \`react\` / \`react-dom\`，只验证注册与纯函数，不渲染真实 DOM。
- 该报告由 \`tests/run.mjs\` 覆盖生成，请勿手工编辑。
`

fs.writeFileSync(new URL('./REPORT.md', import.meta.url), report, 'utf8')

// 机器可读结果，供聚合脚本使用。
fs.writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify({
  generatedAt: startedAt.toISOString(),
  duration,
  passed,
  failed,
  total: rows.length,
  cases: rows.map((row) => ({
    id: row.id,
    title: row.title,
    ok: row.ok,
    ms: row.ms,
    ...(row.error ? { error: String(row.error).split('\n')[0] } : {}),
  })),
}, null, 2), 'utf8')

console.log(`\n${passed} passed, ${failed} failed, ${rows.length} total (${duration} ms)`)
console.log('report: tests/REPORT.md')

if (failed > 0) process.exitCode = 1
