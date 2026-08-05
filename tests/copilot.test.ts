/**
 * Edge-case suite for the Copilot SDK brand-detection backend.
 *
 * Run: node tests/copilot.test.ts            (unit + image handling, no model calls)
 *      node tests/copilot.test.ts --live     (also calls the real Copilot model)
 */
import { cleanBrand, normalizeImage, extractBrandViaCopilot, shutdownCopilot, getBackendInfo } from '../lib/copilot.ts'
import sharp from 'sharp'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const LIVE = process.argv.includes('--live')
let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`) }
}

async function throws(name: string, fn: () => Promise<unknown>, expected: RegExp) {
  try {
    await fn()
    check(name, false, '(expected a throw, got success)')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    check(name, expected.test(msg), `(got "${msg}")`)
  }
}

const MB = 1024 * 1024
const png = (w: number, h: number, rgb = { r: 220, g: 30, b: 40 }) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer()

async function noisyPng(w: number, h: number) {
  const raw = Buffer.alloc(w * h * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256)
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
}

console.log('\n=== 1. cleanBrand: model output sanitisation ===')
check('plain brand', cleanBrand('Nike') === 'Nike')
check('strips markdown bold', cleanBrand('**Spotify**') === 'Spotify')
check('strips quotes', cleanBrand('"BMW"') === 'BMW')
check('strips backticks', cleanBrand('`Airbnb`') === 'Airbnb')
check('strips trailing period', cleanBrand("McDonald's.") === "McDonald's")
check('takes last non-empty line', cleanBrand('thinking...\n\nCoca-Cola') === 'Coca-Cola')
check('collapses whitespace', cleanBrand('  Burger   King  ') === 'Burger King')
check('multi-word brand kept', cleanBrand('Coca Cola Zero Sugar') === 'Coca Cola Zero Sugar')
check('undefined -> Unknown', cleanBrand(undefined) === 'Unknown')
check('empty string -> Unknown', cleanBrand('') === 'Unknown')
check('whitespace -> Unknown', cleanBrand('   \n  ') === 'Unknown')
check('punctuation only -> Unknown', cleanBrand('***') === 'Unknown')
// The real failure seen in testing: a missing attachment makes the model chat back.
check(
  'conversational reply -> Unknown',
  cleanBrand("I don't see any images attached to your message. Could you please share the screenshot?") === 'Unknown'
)
check('5+ words -> Unknown', cleanBrand('The brand here is clearly Nike') === 'Unknown')
check('apology -> Unknown', cleanBrand('Sorry, I cannot help') === 'Unknown')
check('"The image shows" -> Unknown', cleanBrand('The image shows Nike') === 'Unknown')
check('over-long single token -> Unknown', cleanBrand('A'.repeat(41)) === 'Unknown')
check('literal Unknown preserved', cleanBrand('Unknown') === 'Unknown')

console.log('\n=== 2. normalizeImage: format + size handling ===')
const small = await png(400, 200)
const r1 = await normalizeImage(small, 3 * MB)
check('small png passes through untouched', r1.data === small && r1.ext === 'png')

const jpg = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer()
const r2 = await normalizeImage(jpg, 3 * MB)
check('small jpeg passes through untouched', r2.data === jpg && r2.ext === 'jpg')

// GIF/WEBP are accepted by the app but not declared by every vision model.
const gif = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 9, g: 9, b: 9 } } }).gif().toBuffer()
const r3 = await normalizeImage(gif, 3 * MB)
check('gif converted to png/jpg', ['png', 'jpg'].includes(r3.ext) && (await sharp(r3.data).metadata()).format !== 'gif')

const webp = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 5, g: 5, b: 5 } } }).webp().toBuffer()
const r4 = await normalizeImage(webp, 3 * MB)
check('webp converted to png/jpg', ['png', 'jpg'].includes(r4.ext))

// The case that previously hung the request for 90s.
const huge = await noisyPng(3000, 3000)
console.log(`  (generated ${(huge.length / MB).toFixed(1)}MB source image)`)
const r5 = await normalizeImage(huge, 3 * MB)
check('27MB image compressed under 3MB cap', r5.data.length <= 3 * MB, `(got ${(r5.data.length / MB).toFixed(2)}MB)`)
check('compressed image still decodable', (await sharp(r5.data).metadata()).width! > 0)

const wide = await noisyPng(4000, 500)
const r6 = await normalizeImage(wide, 3 * MB)
const m6 = await sharp(r6.data).metadata()
check('oversized dimensions clamped to 1024', Math.max(m6.width!, m6.height!) <= 1024, `(got ${m6.width}x${m6.height})`)
check('aspect ratio preserved', Math.abs(m6.width! / m6.height! - 8) < 0.1, `(got ratio ${(m6.width! / m6.height!).toFixed(2)})`)

// A very tight cap forces the JPEG-quality fallback ladder.
const r7 = await normalizeImage(huge, 200 * 1024)
check('respects a small custom cap', r7.data.length <= 200 * 1024, `(got ${(r7.data.length / 1024).toFixed(0)}KB)`)

const tiny = await png(1, 1)
const r8 = await normalizeImage(tiny, 3 * MB)
check('1x1 image handled', r8.data.length > 0)

console.log('\n=== 3. normalizeImage: invalid input ===')
await throws('corrupt bytes rejected', () => normalizeImage(Buffer.from('not an image at all'), 3 * MB), /not a readable image/i)
await throws('empty buffer rejected', () => normalizeImage(Buffer.alloc(0), 3 * MB), /not a readable image/i)
await throws('text file with png name rejected', () => normalizeImage(Buffer.from('<html>hi</html>'), 3 * MB), /not a readable image/i)
await throws('empty buffer to extractBrand', () => extractBrandViaCopilot(Buffer.alloc(0), 'image/png'), /empty image/i)

if (!LIVE) {
  console.log('\n(skipping live model calls — pass --live to include them)')
} else {
  console.log('\n=== 4. LIVE: real brand detection ===')
  const info = await getBackendInfo()
  console.log(`  backend model: ${info.model}, max image bytes: ${info.maxImageBytes}`)

  const dir = join(process.cwd(), 'test-content')
  const expected: Record<string, RegExp> = {
    'nike.png': /nike/i,
    'spotify.png': /spotify/i,
    'bmw.png': /bmw/i,
    'airbnb.png': /airbnb/i,
    'mcdonalds.png': /mcdonald/i,
  }
  const files = readdirSync(dir).filter(f => f in expected)
  const t0 = Date.now()
  const got = await Promise.all(
    files.map(async f => [f, await extractBrandViaCopilot(readFileSync(join(dir, f)), 'image/png')] as const)
  )
  console.log(`  (${files.length} images in parallel: ${Date.now() - t0}ms)`)
  for (const [f, brand] of got) check(`detects ${f} -> "${brand}"`, expected[f].test(brand), `(got "${brand}")`)

  // Previously this hung until the 90s timeout. Use a real screenshot upscaled past
  // the vision cap rather than random noise, which is both unrealistic and slow for
  // the model to reason about.
  const bigReal = await sharp(readFileSync(join(dir, 'nike.png')))
    .resize(4000, 4000, { fit: 'inside' })
    .png({ compressionLevel: 0 })
    .toBuffer()
  console.log(`  (upscaled real screenshot: ${(bigReal.length / MB).toFixed(1)}MB)`)
  const tBig = Date.now()
  try {
    const bigBrand = await extractBrandViaCopilot(bigReal, 'image/png')
    const elapsed = Date.now() - tBig
    check('oversized image completes without hanging', elapsed < 60000, `(took ${elapsed}ms)`)
    check('oversized image still detects the brand', /nike/i.test(bigBrand), `(got "${bigBrand}")`)
  } catch (err) {
    check('oversized image completes without hanging', false, `(threw: ${(err as Error).message})`)
  }

  const blank = await png(600, 400, { r: 255, g: 255, b: 255 })
  const blankBrand = await extractBrandViaCopilot(blank, 'image/png')
  check('blank image -> Unknown', blankBrand === 'Unknown', `(got "${blankBrand}")`)

  const gifBrand = await extractBrandViaCopilot(gif, 'image/gif')
  check('gif input accepted end-to-end', typeof gifBrand === 'string' && gifBrand.length > 0, `(got "${gifBrand}")`)

  await shutdownCopilot()
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`)
if (failures.length) console.log('  failed: ' + failures.join(' | '))
process.exit(fail === 0 ? 0 : 1)
