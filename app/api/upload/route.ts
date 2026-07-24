import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet } from '@/lib/google'
import { extractBrand } from '@/lib/claude'
import { uploadToImgbb } from '@/lib/imgbb'
import { extractBrandViaCopilot } from '@/lib/copilotMock'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg']
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

// googleapis needs the Node runtime; allow headroom for paced/retried free-tier Gemini calls.
export const runtime = 'nodejs'
export const maxDuration = 60
// Files processed in parallel. Lower is gentler on Gemini free-tier rate limits.
const CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY ?? 2))

type UploadResult =
  | { index: number; name: string; ok: true; brand: string; driveLink: string }
  | { index: number; name: string; ok: false; error: string }

// Bounded-concurrency map so large batches don't fire every imgbb/Gemini call at once.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// Demo mode derives a brand from the filename instead of calling Gemini (no key/quota needed).
function demoBrand(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return base ? base.replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown'
}

async function processFile(file: File, index: number, person: string): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { index, name: file.name, ok: false, error: 'Only image files are allowed (JPG, PNG, GIF, WEBP)' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { index, name: file.name, ok: false, error: 'File must be under 10MB' }
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // Upload + brand detection run in parallel per image.
    const detectBrand = process.env.COPILOT_MOCK
      ? extractBrandViaCopilot(buffer, file.type)
      : process.env.DEMO_MODE
      ? Promise.resolve(demoBrand(file.name))
      : extractBrand(buffer, file.type)
    const [driveLink, brand] = await Promise.all([
      uploadToImgbb(buffer, file.name),
      detectBrand,
    ])
    return { index, name: file.name, ok: true, brand, driveLink }
  } catch (err) {
    return { index, name: file.name, ok: false, error: err instanceof Error ? err.message : 'Processing failed' }
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const files = formData.getAll('file').filter((f): f is File => f instanceof File)
    const person = formData.get('person') as string | null

    if (files.length === 0) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!person) return NextResponse.json({ error: 'No person selected' }, { status: 400 })

    const results = await mapLimit(files, CONCURRENCY, (file, index) => processFile(file, index, person))

    const date = new Date().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })

    const rows: string[][] = []
    const uploaded: { index: number; name: string; brand: string; driveLink: string }[] = []
    const failed: { index: number; name: string; error: string }[] = []
    for (const r of results) {
      if (r.ok) {
        rows.push([date, r.brand, person, r.driveLink])
        uploaded.push({ index: r.index, name: r.name, brand: r.brand, driveLink: r.driveLink })
      } else {
        failed.push({ index: r.index, name: r.name, error: r.error })
      }
    }

    // One batch append for every successfully processed image.
    if (rows.length > 0) await appendToSheet(rows)

    return NextResponse.json({
      success: failed.length === 0,
      count: uploaded.length,
      date,
      person,
      uploaded,
      failed,
    })
  } catch (err) {
    console.error('Upload error:', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
