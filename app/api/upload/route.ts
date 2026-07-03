import { NextRequest, NextResponse } from 'next/server'
import { appendToSheet } from '@/lib/google'
import { extractBrand } from '@/lib/claude'
import { uploadToImgbb } from '@/lib/imgbb'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg']
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const person = formData.get('person') as string | null

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!person) return NextResponse.json({ error: 'No person selected' }, { status: 400 })

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Only image files are allowed (JPG, PNG, GIF, WEBP)' }, { status: 400 })
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: 'File must be under 10MB' }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // Run imgbb upload and brand extraction in parallel
    const [driveLink, brand] = await Promise.all([
      uploadToImgbb(buffer, file.name),
      extractBrand(buffer, file.type),
    ])

    const date = new Date().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })

    await appendToSheet([date, brand, person, driveLink])

    return NextResponse.json({ success: true, brand, driveLink, date, person })
  } catch (err) {
    console.error('Upload error:', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
