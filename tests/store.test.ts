/**
 * Regression tests for the local demo store used when Google creds aren't set.
 *
 * Run: node tests/store.test.ts
 */
import { appendToSheet, getSheetData } from '../lib/google.ts'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

const STORE = join(process.cwd(), '.demo-data', 'rows.json')
let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}

if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.log('GOOGLE_SERVICE_ACCOUNT_JSON is set — demo store inactive, skipping.')
  process.exit(0)
}

// Preserve whatever is already there so running tests doesn't destroy local data.
const backup = await fsp.readFile(STORE, 'utf8').catch(() => null)

try {
  console.log('\n=== demo store: concurrent appends ===')
  await fsp.mkdir(join(process.cwd(), '.demo-data'), { recursive: true })
  await fsp.writeFile(STORE, '[]')

  // Previously this kept only 1 of 20 rows: every caller read the same snapshot and
  // the last write won.
  const N = 25
  await Promise.all(Array.from({ length: N }, (_, i) => appendToSheet([[`d${i}`, `brand${i}`, 'tester', `/x/${i}`]])))
  const rows = await getSheetData()
  check(`${N} concurrent appends all persisted`, rows.length === N, `(got ${rows.length})`)

  const brands = new Set(rows.map(r => r[1]))
  check('no rows overwritten', brands.size === N, `(got ${brands.size} unique)`)
  check('row shape intact', rows.every(r => r.length === 4))

  console.log('\n=== demo store: batch + sequential ===')
  await fsp.writeFile(STORE, '[]')
  await appendToSheet([['d', 'a', 'p', '/1'], ['d', 'b', 'p', '/2']])
  await appendToSheet([['d', 'c', 'p', '/3']])
  const rows2 = await getSheetData()
  check('batch then single append', rows2.length === 3, `(got ${rows2.length})`)
  check('append order preserved', rows2.map(r => r[1]).join(',') === 'a,b,c', `(got ${rows2.map(r => r[1]).join(',')})`)

  console.log('\n=== demo store: corrupt / missing file ===')
  await fsp.writeFile(STORE, 'this is not json')
  check('corrupt store reads as empty', (await getSheetData()).length === 0)
  await appendToSheet([['d', 'recovered', 'p', '/r']])
  check('corrupt store recovers on write', (await getSheetData()).length === 1)

  await fsp.writeFile(STORE, '{"not":"an array"}')
  check('non-array store reads as empty', (await getSheetData()).length === 0)

  await fsp.unlink(STORE).catch(() => {})
  check('missing store reads as empty', (await getSheetData()).length === 0)
  await appendToSheet([['d', 'fresh', 'p', '/f']])
  check('missing store is recreated', (await getSheetData()).length === 1)

  console.log('\n=== demo store: no temp files left behind ===')
  const leftovers = (await fsp.readdir(join(process.cwd(), '.demo-data'))).filter(f => f.includes('.tmp'))
  check('no .tmp files remain', leftovers.length === 0, `(found ${leftovers.join(', ')})`)
} finally {
  if (backup !== null) await fsp.writeFile(STORE, backup)
  else await fsp.unlink(STORE).catch(() => {})
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`)
if (failures.length) console.log('  failed: ' + failures.join(' | '))
process.exit(fail === 0 ? 0 : 1)
