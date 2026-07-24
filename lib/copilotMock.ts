import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// LOCAL-ONLY mock: use the GitHub Copilot CLI (the user's subscription) as the
// vision model for brand detection, standing in for Gemini. Not part of the repo/PR.

const PROMPT =
  'This is an advertisement screenshot. Reply with ONLY the brand or company being ' +
  'advertised, at most 4 words, nothing else. If you cannot tell, reply Unknown.'

const TIMEOUT_MS = Math.max(10000, Number(process.env.COPILOT_MOCK_TIMEOUT_MS ?? 120000))

export async function extractBrandViaCopilot(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = (mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const tmp = join(tmpdir(), `adshot-${randomUUID()}.${ext}`)
  await fs.writeFile(tmp, buffer)
  try {
    const bin = process.env.COPILOT_BIN || 'copilot'
    const cmd = `${bin} -p "${PROMPT}" --attachment "${tmp}" --allow-all-tools -s --no-color`
    const raw = await runShell(cmd)
    return cleanBrand(raw)
  } finally {
    fs.unlink(tmp).catch(() => {})
  }
}

function runShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('copilot CLI timed out'))
    }, TIMEOUT_MS)
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `copilot CLI exited with code ${code}`))
    })
  })
}

// The CLI prints just the answer with -s; take the last non-empty line and strip quotes/markdown.
function cleanBrand(raw: string): string {
  const line = raw.split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
  const brand = line.replace(/^["'`*_]+|["'`*_]+$/g, '').trim()
  return brand || 'Unknown'
}
