import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet, getSheetData } from '@/lib/google'
import { extractBrand } from '@/lib/claude'
import { uploadToImgbb } from '@/lib/imgbb'

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

/**
 * Extract filename from an imgbb URL.
 * imgbb URLs look like: https://i.ibb.co/abc123/original-filename.jpg
 */
function filenameFromImgbbUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').pop() || ''
    // Strip imgbb's random prefix (e.g. "abc123-") if present
    return filename.replace(/^[a-zA-Z0-9]+-/, '')
  } catch {
    return ''
  }
}

/**
 * Check if a filename has already been uploaded by this person.
 * Looks at existing sheet rows and compares the imgbb URL filename.
 */
async function isDuplicate(person: string, filename: string): Promise<boolean> {
  const rows = await getSheetData()
  const normalized = filename.toLowerCase()
  return rows.some(row => {
    if (row[2] !== person) return false
    const existingName = filenameFromImgbbUrl(row[3])
    return existingName.toLowerCase() === normalized
  })
}

async function processFile(file: File, index: number, person: string): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { index, name: file.name, ok: false, error: 'Only image files are allowed (JPG, PNG, GIF, WEBP)' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { index, name: file.name, ok: false, error: 'File must be under 10MB' }
  }

  // Check for duplicate filename for this person
  const dup = await isDuplicate(person, file.name)
  if (dup) {
    return {
      index,
      name: file.name,
      ok: false,
      error: `"${file.name}" was already uploaded by ${person}. Screenshot names must be unique per person.`,
    }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const driveLink = await uploadToImgbb(buffer, file.name)
    // extractBrand never throws — always returns a string ("Unknown" on failure)
    const brand = await extractBrand(buffer, file.type)
    return { index, name: file.name, ok: true, brand, driveLink }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Processing failed'
    if (msg.includes('imgbb') || msg.includes('imgbb.com')) {
      return { index, name: file.name, ok: false, error: `Image hosting (imgbb) failed: ${msg}. Try again later.` }
    }
    return { index, name: file.name, ok: false, error: msg }
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
