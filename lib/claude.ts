import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

// Free-tier friendly, all tunable via env.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'
// Minimum spacing between model calls (ms). 0 = disabled. Set e.g. 6000 to stay under ~10 req/min.
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 0))
// Retries on HTTP 429 (rate limit) before giving up.
const MAX_RETRIES = Math.max(0, Number(process.env.GEMINI_MAX_RETRIES ?? 3))
// Cap for any single backoff so a serverless request can't hang past its maxDuration.
const MAX_BACKOFF_MS = Math.max(1000, Number(process.env.GEMINI_MAX_BACKOFF_MS ?? 15000))

const PROMPT =
  'This is an advertisement screenshot. What is the brand or company being advertised? ' +
  'Reply with ONLY the brand name (1-4 words max), nothing else. ' +
  'If you cannot determine the brand, reply with "Unknown".'

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

// Serialize + space out model calls so bursts don't blow the free-tier per-minute quota.
let gate: Promise<unknown> = Promise.resolve()
let lastCallAt = 0
function paced<T>(fn: () => Promise<T>): Promise<T> {
  if (MIN_INTERVAL_MS <= 0) return fn()
  const run = gate.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
    return fn()
  })
  gate = run.then(() => undefined, () => undefined)
  return run
}

export function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('"code":429') || msg.includes('RESOURCE_EXHAUSTED') || /\b429\b|rate.?limit/i.test(msg)
}

// The API returns RetryInfo like {"retryDelay":"58s"} — honor it when present.
export function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null
}

async function generateOnce(imageBuffer: Buffer, mimeType: string): Promise<string> {
  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
  })
  const text = result.text?.trim()
  return text && text.toLowerCase() !== 'undefined' ? text : 'Unknown'
}

export async function extractBrand(imageBuffer: Buffer, mimeType: string): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await paced(() => generateOnce(imageBuffer, mimeType))
    } catch (err) {
      lastErr = err
      if (!isRateLimited(err) || attempt === MAX_RETRIES) break
      // Prefer the server's suggested delay; otherwise exponential backoff. Cap either way, add jitter.
      const suggested = retryDelayMs(err)
      const backoff = Math.min(suggested ?? 1000 * 2 ** attempt, MAX_BACKOFF_MS)
      await sleep(backoff + Math.floor(Math.random() * 250))
    }
  }
  // Never throw — return Unknown so the upload batch continues.
  console.error('[brand] Gemini failed after retries:', lastErr)
  return 'Unknown'
}
