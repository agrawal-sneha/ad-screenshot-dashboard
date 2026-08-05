import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet } from '@/lib/google'
import { extractBrand } from '@/lib/claude'
import { uploadToImgbb } from '@/lib/imgbb'
import { extractBrandViaCopilot } from '@/lib/copilot'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg']
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_FILES = envInt(process.env.UPLOAD_MAX_FILES, 50, 1)

export const runtime = 'nodejs'
export const maxDuration = 300
// Files processed in parallel. Each one gets its own Copilot session.
const CONCURRENCY = envInt(process.env.UPLOAD_CONCURRENCY, 4, 1)

// Number(undefined) and Number('abc') are both NaN, and NaN silently poisoned the
// concurrency limit (zero workers, every upload failing), so bad values fall back.
function envInt(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback
}

// Any non-empty string is truthy, so `DEMO_MODE=false` used to still enable demo mode.
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false
  return !['false', '0', 'no', 'off', ''].includes(raw.trim().toLowerCase())
}

// Copilot SDK is the default brand backend; it uses the local Copilot subscription
// rather than a separate API key.
const USE_GEMINI = envFlag(process.env.USE_GEMINI)
const DEMO_MODE = envFlag(process.env.DEMO_MODE)

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

async function processFile(file: File, index: number): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { index, name: file.name, ok: false, error: 'Only image files are allowed (JPG, PNG, GIF, WEBP)' }
  }
  if (file.size === 0) {
    return { index, name: file.name, ok: false, error: 'File is empty' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { index, name: file.name, ok: false, error: 'File must be under 10MB' }
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // Upload + brand detection run in parallel per image.
    const detectBrand = DEMO_MODE
      ? Promise.resolve(demoBrand(file.name))
      : USE_GEMINI
      ? extractBrand(buffer, file.type)
      : extractBrandViaCopilot(buffer, file.type)
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
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files — max ${MAX_FILES} per upload` }, { status: 400 })
    }

    const results = await mapLimit(files, CONCURRENCY, (file, index) => processFile(file, index))

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
