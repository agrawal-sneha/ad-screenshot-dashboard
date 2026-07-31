import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet, getSheetData, uploadToDrive } from '@/lib/google'
import { extractBrand } from '@/lib/claude'

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
 * Extract filename from a Drive URL.
 * Drive URLs look like: https://drive.google.com/file/d/ABC123/view
 */
function filenameFromDriveUrl(url: string): string {
  try {
    const match = url.match(/\/file\/d\/([^/]+)/)
    if (!match) return ''
    // We don't have the original filename in the Drive URL,
    // so we use the file ID as the identifier for duplicate checking.
    // Duplicate prevention relies on the original filename instead.
    return ''
  } catch {
    return ''
  }
}

/**
 * Check if a filename has already been uploaded by this person.
 * Looks at existing sheet rows and compares the original filename.
 * Since Drive URLs don't contain the filename, we check if the same person
 * has uploaded the same number of files with similar timing.
 * A simpler approach: store original filename in a separate column or
 * check by Drive file ID pattern.
 *
 * For now, we skip duplicate checking for Drive uploads since the URL
 * doesn't contain the original filename. The duplicate prevention
 * is mainly to avoid re-uploading the same screenshot.
 */
async function isDuplicate(person: string, filename: string): Promise<boolean> {
  // With Google Drive hosting, we can't reliably extract the original filename
  // from the Drive URL. Skip duplicate check for Drive-based uploads.
  // The frontend can show upload history to help users avoid duplicates.
  return false
}

async function processFile(file: File, index: number, person: string): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { index, name: file.name, ok: false, error: 'Only image files are allowed (JPG, PNG, GIF, WEBP)' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { index, name: file.name, ok: false, error: 'File must be under 10MB' }
  }

  // Check for duplicate filename for this person
  const existingRows = await getSheetData()
  const normalized = file.name.toLowerCase()
  const isDup = existingRows.some(
    row => row[2] === person && (row[4]?.toLowerCase() === normalized)
  )
  if (isDup) {
    return {
      index,
      name: file.name,
      ok: false,
      error: `"${file.name}" was already uploaded by ${person}. Screenshot names must be unique per person.`,
    }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // Upload to Google Drive instead of ImgBB (no rate limits!)
    const driveLink = await uploadToDrive(buffer, file.name, file.type)
    // extractBrand never throws — always returns a string ("Unknown" on failure)
    const brand = await extractBrand(buffer, file.type)
    return { index, name: file.name, ok: true, brand, driveLink }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Processing failed'
    if (msg.includes('google') || msg.includes('Drive') || msg.includes('sheet')) {
      return { index, name: file.name, ok: false, error: `Google service failed: ${msg}. Try again later.` }
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
        rows.push([date, r.brand, person, r.driveLink, r.name]) // name stored for duplicate checking
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
