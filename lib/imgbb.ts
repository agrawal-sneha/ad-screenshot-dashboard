import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export async function uploadToImgbb(buffer: Buffer, filename: string): Promise<string> {
  // Local demo fallback when no imgbb key is set: persist under /public/uploads and serve statically.
  if (!process.env.IMGBB_API_KEY) {
    const safe = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const dir = join(process.cwd(), 'public', 'uploads')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, safe), buffer)
    return `/uploads/${safe}`
  }

  const base64 = buffer.toString('base64')

  const form = new URLSearchParams()
  form.append('key', process.env.IMGBB_API_KEY!)
  form.append('image', base64)
  form.append('name', filename)

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
  })

  const json = await res.json()
  if (!json.success) throw new Error(json.error?.message || 'imgbb upload failed')

  return json.data.url as string
}
