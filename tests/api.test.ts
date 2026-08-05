/**
 * End-to-end dashboard tests against a running dev server.
 *
 * Start `npm run dev` first, then: node tests/api.test.ts
 */
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000'
let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer()

function form(files: Array<{ name: string; body: BufferSource; type: string }>, person?: string) {
  const fd = new FormData()
  for (const f of files) fd.append('file', new Blob([f.body], { type: f.type }), f.name)
  if (person !== undefined) fd.append('person', person)
  return fd
}

const upload = (fd: FormData) => fetch(`${BASE}/api/upload`, { method: 'POST', body: fd })
const rowCount = async () => ((await (await fetch(`${BASE}/api/screenshots`)).json()).rows ?? []).length

console.log('\n=== 1. GET /api/screenshots ===')
const res0 = await fetch(`${BASE}/api/screenshots`)
const body0 = await res0.json()
check('returns 200', res0.status === 200)
check('returns a rows array', Array.isArray(body0.rows), `(got ${JSON.stringify(body0).slice(0, 120)})`)
const startRows = body0.rows.length
console.log(`  (${startRows} existing rows)`)

console.log('\n=== 2. Request validation ===')
const r1 = await upload(form([], 'Sneha'))
check('no files -> 400', r1.status === 400)
check('no files -> error message', (await r1.json()).error === 'No file provided')

const r2 = await upload(form([{ name: 'a.png', body: await png(50, 50), type: 'image/png' }]))
check('no person -> 400', r2.status === 400)
check('no person -> error message', (await r2.json()).error === 'No person selected')

const many = await Promise.all(
  Array.from({ length: 51 }, async (_, i) => ({ name: `f${i}.png`, body: await png(20, 20), type: 'image/png' }))
)
const r3 = await upload(form(many, 'Sneha'))
check('51 files -> 400', r3.status === 400)
check('too many files -> error message', /Too many files/.test((await r3.json()).error))

console.log('\n=== 3. Per-file rejection (batch survives) ===')
const before = await rowCount()
const r4 = await upload(form([{ name: 'notes.txt', body: Buffer.from('hello'), type: 'text/plain' }], 'Sneha'))
const b4 = await r4.json()
check('non-image -> 200 with failure entry', r4.status === 200 && b4.failed.length === 1, `(${JSON.stringify(b4).slice(0, 160)})`)
check('non-image -> success:false', b4.success === false)
check('non-image -> nothing uploaded', b4.count === 0)
check('non-image -> correct error', /Only image files/.test(b4.failed[0].error))
check('non-image -> no row written', (await rowCount()) === before)

const r5 = await upload(form([{ name: 'empty.png', body: Buffer.alloc(0), type: 'image/png' }], 'Sneha'))
const b5 = await r5.json()
check('empty file -> failure entry', b5.failed.length === 1 && /empty/i.test(b5.failed[0].error), `(${JSON.stringify(b5.failed)})`)

const r6 = await upload(form([{ name: 'corrupt.png', body: Buffer.from('definitely not a png'), type: 'image/png' }], 'Sneha'))
const b6 = await r6.json()
check('corrupt image -> failure entry, no crash', r6.status === 200 && b6.failed.length === 1, `(${JSON.stringify(b6).slice(0, 200)})`)
check('corrupt image -> readable error', /not a readable image/i.test(b6.failed[0].error), `(got "${b6.failed[0]?.error}")`)

console.log('\n=== 4. Happy path: real ad screenshots ===')
const dir = join(process.cwd(), 'test-content')
const realFiles = ['nike.png', 'spotify.png'].map(n => ({
  name: n,
  body: readFileSync(join(dir, n)),
  type: 'image/png',
}))
const beforeReal = await rowCount()
const t0 = Date.now()
const r7 = await upload(form(realFiles, 'Sneha'))
const b7 = await r7.json()
console.log(`  (2 images in ${Date.now() - t0}ms)`)
check('happy path -> 200', r7.status === 200)
check('happy path -> success true', b7.success === true, `(${JSON.stringify(b7).slice(0, 200)})`)
check('happy path -> count 2', b7.count === 2)
check('happy path -> no failures', b7.failed.length === 0)
check('detects Nike', b7.uploaded.some((u: { brand: string }) => /nike/i.test(u.brand)), `(${JSON.stringify(b7.uploaded)})`)
check('detects Spotify', b7.uploaded.some((u: { brand: string }) => /spotify/i.test(u.brand)))
check('returns a date', typeof b7.date === 'string' && b7.date.length > 0)
check('echoes person', b7.person === 'Sneha')
check('every upload has a link', b7.uploaded.every((u: { driveLink: string }) => !!u.driveLink))
check('2 new rows persisted', (await rowCount()) === beforeReal + 2, `(before ${beforeReal}, now ${await rowCount()})`)

const link = b7.uploaded[0].driveLink
const imgRes = await fetch(`${BASE}${link}`)
check('uploaded image is served', imgRes.status === 200, `(${link} -> ${imgRes.status})`)
check('served as an image', (imgRes.headers.get('content-type') || '').startsWith('image/'))

console.log('\n=== 5. Partial failure: good + bad in one batch ===')
const beforeMixed = await rowCount()
const r8 = await upload(form([
  { name: 'bmw.png', body: readFileSync(join(dir, 'bmw.png')), type: 'image/png' },
  { name: 'bad.txt', body: Buffer.from('nope'), type: 'text/plain' },
  { name: 'airbnb.png', body: readFileSync(join(dir, 'airbnb.png')), type: 'image/png' },
], 'Rao'))
const b8 = await r8.json()
check('mixed -> 200', r8.status === 200)
check('mixed -> success false', b8.success === false)
check('mixed -> 2 uploaded', b8.count === 2, `(${JSON.stringify(b8).slice(0, 200)})`)
check('mixed -> 1 failed', b8.failed.length === 1)
// The UI keeps only failed files for retry using this index, so it must be the original position.
check('mixed -> failed index preserved', b8.failed[0].index === 1, `(got ${b8.failed[0]?.index})`)
check('mixed -> only good rows persisted', (await rowCount()) === beforeMixed + 2)

console.log('\n=== 6. Format coverage ===')
const webp = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 7, g: 7, b: 7 } } }).webp().toBuffer()
const gif = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 8, g: 8, b: 8 } } }).gif().toBuffer()
const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 6, g: 6, b: 6 } } }).jpeg().toBuffer()
const r9 = await upload(form([
  { name: 'a.webp', body: webp, type: 'image/webp' },
  { name: 'b.gif', body: gif, type: 'image/gif' },
  { name: 'c.jpg', body: jpg, type: 'image/jpeg' },
], 'Kalyan'))
const b9 = await r9.json()
check('webp/gif/jpeg all accepted', b9.count === 3, `(${JSON.stringify(b9).slice(0, 250)})`)
check('no failures across formats', b9.failed.length === 0)

console.log('\n=== 7. Oversized image (previously hung) ===')
const rawBig = Buffer.alloc(2600 * 2600 * 3)
for (let i = 0; i < rawBig.length; i++) rawBig[i] = Math.floor(Math.random() * 256)
const bigPng = await sharp(rawBig, { raw: { width: 2600, height: 2600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
console.log(`  (${(bigPng.length / 1048576).toFixed(1)}MB source)`)
if (bigPng.length > 10 * 1024 * 1024) {
  const rOver = await upload(form([{ name: 'huge.png', body: bigPng, type: 'image/png' }], 'Sneha'))
  const bOver = await rOver.json()
  check('>10MB rejected by size guard', bOver.failed?.[0]?.error === 'File must be under 10MB', `(${JSON.stringify(bOver).slice(0, 200)})`)
}
const midPng = await sharp(rawBig, { raw: { width: 2600, height: 2600, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
console.log(`  (${(midPng.length / 1048576).toFixed(1)}MB jpeg, above the 3MB vision cap)`)
const tBig = Date.now()
const r10 = await upload(form([{ name: 'big.jpg', body: midPng, type: 'image/jpeg' }], 'Sneha'))
const b10 = await r10.json()
const bigMs = Date.now() - tBig
check('above-cap image completes', b10.count === 1, `(${JSON.stringify(b10).slice(0, 200)})`)
check('above-cap image did not hang', bigMs < 60000, `(took ${bigMs}ms)`)

console.log('\n=== 8. Concurrency ===')
const beforeConc = await rowCount()
const t1 = Date.now()
const conc = await Promise.all([
  upload(form([{ name: 'nike.png', body: readFileSync(join(dir, 'nike.png')), type: 'image/png' }], 'A')),
  upload(form([{ name: 'bmw.png', body: readFileSync(join(dir, 'bmw.png')), type: 'image/png' }], 'B')),
  upload(form([{ name: 'spotify.png', body: readFileSync(join(dir, 'spotify.png')), type: 'image/png' }], 'C')),
])
const concBodies = await Promise.all(conc.map(r => r.json()))
console.log(`  (3 concurrent requests in ${Date.now() - t1}ms)`)
check('all concurrent requests ok', concBodies.every(b => b.count === 1), `(${JSON.stringify(concBodies).slice(0, 250)})`)
check('no rows lost under concurrency', (await rowCount()) === beforeConc + 3, `(expected ${beforeConc + 3}, got ${await rowCount()})`)

console.log('\n=== 9. Table ordering ===')
const finalRows = (await (await fetch(`${BASE}/api/screenshots`)).json()).rows
check('newest row first', Array.isArray(finalRows) && finalRows.length > 0)
check('rows have 4 columns', finalRows[0].length === 4, `(got ${JSON.stringify(finalRows[0])})`)
check('header row not returned', !/^date$/i.test(finalRows[finalRows.length - 1][0]))

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`)
if (failures.length) console.log('  failed: ' + failures.join(' | '))
process.exit(fail === 0 ? 0 : 1)
