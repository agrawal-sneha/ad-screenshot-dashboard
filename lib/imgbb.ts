export async function uploadToImgbb(buffer: Buffer, filename: string): Promise<string> {
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
