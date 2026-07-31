import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet, getSheetData } from '@/lib/google'
import sharp from 'sharp'
import { extractBrand } from '@/lib/claude'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg']
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_DIMENSION = 400 // max width/height in px

// Node runtime needed for sharp and Gemini calls.
export const runtime = 'nodejs'
export const maxDuration = 60
// Files processed in parallel. Lower is gentler on Gemini free-tier rate limits.
const CONCURRENCY = Math.max(1, Number(process.env.UPLOAD_CONCURRENCY ?? 2))

type UploadResult =
  | { index: number; name: string; ok: true; brand: string; dataUrl: string }
  | { index: number; name: string; ok: false; error: string }

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

async function resizeToDataUrl(buffer: Buffer, mimeType: string): Promise<string> {
  let img = sharp(buffer)
  const meta = await img.metadata()

  if (meta.width && meta.height) {
    const maxD = MAX_DIMENSION
    let width = meta.width
    let height = meta.height
    if (width > height && width > maxD) {
      height = Math.round(height * maxD / width)
      width = maxD
    } else if (height > maxD) {
      width = Math.round(width * maxD / height)
      height = maxD
    }
    if (width !== meta.width || height !== meta.height) {
      img = img.resize(width, height, { fit: 'inside', withoutEnlargement: true })
    }
  }

  const outputBuffer = await img.toFormat('jpeg', { quality: 70 }).toBuffer()
  const base64 = outputBuffer.toString('base64')
  return `data:image/jpeg;base64,${base64}`
}

async function processFile(file: File, index: number, person: string): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { index, name: file.name, ok: false, error: 'Only image files allowed (JPG, PNG, GIF, WEBP)' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { index, name: file.name, ok: false, error: 'File must be under 10MB' }
  }

  // Duplicate check: same person + same filename
  const existingRows = await getSheetData()
  const normalizedName = file.name.toLowerCase()
  const isDup = existingRows.some(
    row => row[2] === person && (row[4]?.toLowerCase() === normalizedName)
  )
  if (isDup) {
    return {
      index,
      name: file.name,
      ok: false,
      error: `DUPLICATE: "${file.name}" was already uploaded by ${person}. Each person must use unique screenshot names.`,
    }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const dataUrl = await resizeToDataUrl(buffer, file.type)
    // extractBrand never throws — returns "Unknown" on failure
    const brand = await extractBrand(buffer, file.type)
    return { index, name: file.name, ok: true, brand, dataUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Processing failed'
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
      day: '2-digit', month: '2-digit', year: 'numeric',
    })

    const rows: string[][] = []
    const uploaded: { index: number; name: string; brand: string; dataUrl: string }[] = []
    const failed: { index: number; name: string; error: string }[] = []

    for (const r of results) {
      if (r.ok) {
        // Columns: Date | Brand | Shared by | Data URL | Filename
        rows.push([date, r.brand, person, r.dataUrl, r.name])
        uploaded.push({ index: r.index, name: r.name, brand: r.brand, dataUrl: r.dataUrl })
      } else {
        failed.push({ index: r.index, name: r.name, error: r.error })
      }
    }

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
