export async function uploadToImgbb(buffer: Buffer, filename: string): Promise<string> {
  const base64 = buffer.toString('base64')

  const form = new URLSearchParams()
  form.append('key', process.env.IMGBB_API_KEY!)
  form.append('image', base64)
  form.append('name', filename)

  // Retry on rate-limit (429) or transient network errors.
  const MAX_ATTEMPTS = 4
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s, 8s — keeps a single serverless request under maxDuration
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 8000)
      await new Promise(r => setTimeout(r, backoff))
    }
    try {
      const res = await fetch('https://api.imgbb.com/1/upload', {
        method: 'POST',
        body: form,
      })

      const json = await res.json()
      if (json.success) return json.data.url as string

      // Detect rate-limit error from ImgBB response
      const isRateLimit =
        res.status === 429 ||
        /rate.?limit/i.test(json.error?.message || '') ||
        json.error?.code === 429

      if (isRateLimit) {
        lastErr = new Error('Rate limit reached.')
        continue // retry after backoff
      }

      // Non-rate-limit error — surface it immediately
      throw new Error(json.error?.message || 'imgbb upload failed')
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error('imgbb upload failed')
      // Only retry on rate-limit errors; other errors bubble up immediately
      if (!lastErr.message.toLowerCase().includes('rate limit')) {
        throw lastErr
      }
    }
  }
  throw lastErr ?? new Error('imgbb upload failed')
}
