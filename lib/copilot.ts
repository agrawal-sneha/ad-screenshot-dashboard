import { CopilotClient, approveAll, type CopilotSession } from '@github/copilot-sdk'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

/**
 * Brand detection backed by the GitHub Copilot SDK.
 *
 * Uses the caller's Copilot subscription as the vision model, so no separate
 * API key or quota is required.
 */

const PROMPT =
  'This is an advertisement screenshot. Reply with ONLY the brand or company being ' +
  'advertised, at most 4 words, nothing else. Do not explain. Do not use punctuation. ' +
  'If you cannot tell, reply exactly: Unknown'

// Vision models cap inline images (typically 3MB) well below the app's 10MB upload
// limit, and an oversized attachment hangs the request instead of erroring, so every
// image is re-encoded under this ceiling before it is sent.
const FALLBACK_IMAGE_BYTES = 3 * 1024 * 1024
// Vision cost scales with pixel count, and a 1600px clamp made a large screenshot
// take ~70s versus ~10s for a normal one. 1024px on the long edge is still ample for
// reading a logo or brand text, and typical screenshots are already smaller than this
// so they pass through untouched.
const MAX_DIMENSION = 1024
const REQUEST_TIMEOUT_MS = num(process.env.COPILOT_TIMEOUT_MS, 90_000, 10_000)
const PREFERRED_MODELS = ['claude-haiku-4.5', 'claude-sonnet-4.5', 'claude-sonnet-5']

function num(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

type Runtime = { client: CopilotClient; model: string; maxImageBytes: number }

// Next.js hot-reloads modules in dev; hang the runtime off globalThis so we don't
// leak a CLI process on every edit. Starting the client costs ~900ms, so it is
// started once and shared by every request.
const globalRef = globalThis as typeof globalThis & { __adshotCopilot?: Promise<Runtime> }

async function createRuntime(): Promise<Runtime> {
  const client = new CopilotClient()
  await client.start()
  try {
    const models = await client.listModels()
    const vision = models.filter(m => m.capabilities?.supports?.vision)
    if (vision.length === 0) {
      throw new Error('No vision-capable model is available on this Copilot account')
    }

    const requested = process.env.COPILOT_MODEL
    if (requested && !vision.some(m => m.id === requested)) {
      throw new Error(
        `COPILOT_MODEL "${requested}" is not a vision-capable model. ` +
          `Available: ${vision.map(m => m.id).join(', ')}`
      )
    }

    const chosen =
      vision.find(m => m.id === requested) ??
      PREFERRED_MODELS.map(id => vision.find(m => m.id === id)).find(Boolean) ??
      vision[0]

    return {
      client,
      model: chosen.id,
      maxImageBytes: chosen.capabilities.limits?.vision?.max_prompt_image_size ?? FALLBACK_IMAGE_BYTES,
    }
  } catch (err) {
    // Don't leave an orphaned CLI process behind if model selection fails.
    await client.stop().catch(() => {})
    throw err
  }
}

function getRuntime(): Promise<Runtime> {
  if (!globalRef.__adshotCopilot) {
    // Clear the cached promise on failure so the next request retries instead of
    // permanently serving a rejected promise.
    globalRef.__adshotCopilot = createRuntime().catch(err => {
      globalRef.__adshotCopilot = undefined
      throw err
    })
  }
  return globalRef.__adshotCopilot
}

/**
 * Re-encodes an image so the vision model reliably accepts it.
 *
 * Normalizing to PNG/JPEG also sidesteps per-model media-type differences (for
 * example, claude-haiku-4.5 does not declare image/gif support).
 */
export async function normalizeImage(
  buffer: Buffer,
  maxBytes: number = FALLBACK_IMAGE_BYTES
): Promise<{ data: Buffer; ext: string }> {
  let meta
  try {
    meta = await sharp(buffer, { animated: false }).metadata()
  } catch {
    throw new Error('File is not a readable image')
  }
  if (!meta.width || !meta.height) throw new Error('File is not a readable image')

  const base = () => sharp(buffer, { animated: false }).rotate()

  // Already small and in a universally supported format: send as-is.
  if (buffer.length <= maxBytes && (meta.format === 'png' || meta.format === 'jpeg')) {
    return { data: buffer, ext: meta.format === 'jpeg' ? 'jpg' : 'png' }
  }

  const needsResize = Math.max(meta.width, meta.height) > MAX_DIMENSION
  const resized = needsResize
    ? base().resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    : base()

  const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer()
  if (png.length <= maxBytes) return { data: png, ext: 'png' }

  // Fall back to progressively harder JPEG compression for very large images.
  for (const quality of [85, 70, 55, 40]) {
    const jpg = await resized.clone().jpeg({ quality, mozjpeg: true }).toBuffer()
    if (jpg.length <= maxBytes) return { data: jpg, ext: 'jpg' }
  }

  const smaller = await base()
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 60, mozjpeg: true })
    .toBuffer()
  if (smaller.length > maxBytes) throw new Error('Image could not be compressed for analysis')
  return { data: smaller, ext: 'jpg' }
}

/**
 * The model is asked for a bare brand name, but it can still answer
 * conversationally (notably if the attachment fails to reach it). Anything that
 * doesn't look like a brand is treated as Unknown rather than written to the sheet.
 */
export function cleanBrand(raw: string | undefined): string {
  if (!raw) return 'Unknown'
  const line =
    raw
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .pop() ?? ''

  const brand = line
    .replace(/^[\s"'`*_#\-–—]+|[\s"'`*_.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!brand) return 'Unknown'
  // A real answer is 1-4 words; longer means the model explained itself.
  if (brand.split(' ').length > 4) return 'Unknown'
  if (brand.length > 40) return 'Unknown'
  if (/^(i |sorry|unable|cannot|can't|there |the image|this image|no |it )/i.test(brand)) return 'Unknown'
  return brand
}

export async function extractBrandViaCopilot(buffer: Buffer, _mimeType: string): Promise<string> {
  if (!buffer || buffer.length === 0) throw new Error('Empty image file')

  const { client, model, maxImageBytes } = await getRuntime()
  const { data, ext } = await normalizeImage(buffer, maxImageBytes)

  const tmpPath = join(tmpdir(), `adshot-${randomUUID()}.${ext}`)
  await fs.writeFile(tmpPath, data)

  let session: CopilotSession | undefined
  try {
    // A fresh session per image keeps prior screenshots out of the context. Reusing
    // one session made the second image take 38s instead of 6s and risks the model
    // answering about the wrong screenshot.
    session = await client.createSession({
      model,
      availableTools: [],
      onPermissionRequest: approveAll,
    })
    const res = await session.sendAndWait(
      { prompt: PROMPT, attachments: [{ type: 'file', path: tmpPath }] },
      REQUEST_TIMEOUT_MS
    )
    return cleanBrand(res?.data?.content)
  } finally {
    await session?.disconnect().catch(() => {})
    await fs.unlink(tmpPath).catch(() => {})
  }
}

/** Exposed so the dashboard can surface which model is answering. */
export async function getBackendInfo(): Promise<{ model: string; maxImageBytes: number }> {
  const { model, maxImageBytes } = await getRuntime()
  return { model, maxImageBytes }
}

export async function shutdownCopilot(): Promise<void> {
  const pending = globalRef.__adshotCopilot
  globalRef.__adshotCopilot = undefined
  if (!pending) return
  try {
    const { client } = await pending
    await client.stop()
  } catch {
    // Nothing to clean up if the runtime never started.
  }
}
