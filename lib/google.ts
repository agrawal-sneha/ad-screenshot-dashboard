import { google } from 'googleapis'
import { Readable } from 'stream'
import { promises as fsp } from 'node:fs'
import { join, dirname } from 'node:path'

// Local demo store used when Google credentials aren't configured.
const DEMO_STORE = join(process.cwd(), '.demo-data', 'rows.json')
const demoEnabled = () => !process.env.GOOGLE_SERVICE_ACCOUNT_JSON
async function demoRead(): Promise<string[][]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(DEMO_STORE, 'utf8'))
    return Array.isArray(parsed) ? (parsed as string[][]) : []
  } catch { return [] }
}

// Appending is read-modify-write, so parallel uploads would otherwise overwrite each
// other's rows (20 concurrent appends kept only 1). Serialize them through a chain.
let demoWriteQueue: Promise<void> = Promise.resolve()
async function demoAppend(rows: string[][]): Promise<void> {
  const next = demoWriteQueue.then(async () => {
    const cur = await demoRead()
    cur.push(...rows)
    await fsp.mkdir(dirname(DEMO_STORE), { recursive: true })
    // Write to a sibling temp file then rename so a crash mid-write can't truncate
    // the store.
    const tmp = `${DEMO_STORE}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(cur, null, 2))
    await fsp.rename(tmp, DEMO_STORE)
  })
  demoWriteQueue = next.then(() => undefined, () => undefined)
  return next
}

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set')
  const credentials = JSON.parse(raw)
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  })
}

export async function uploadToDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const auth = getAuth()
  const drive = google.drive({ version: 'v3', auth })

  const stream = Readable.from(buffer)

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: process.env.GOOGLE_DRIVE_FOLDER_ID
        ? [process.env.GOOGLE_DRIVE_FOLDER_ID]
        : undefined,
    },
    media: { mimeType, body: stream },
    fields: 'id',
  })

  const fileId = res.data.id!

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  })

  return `https://drive.google.com/file/d/${fileId}/view`
}

export async function appendToSheet(rows: string[][]) {
  if (demoEnabled()) return demoAppend(rows)
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Sheet1!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  })
}

export async function getSheetData(): Promise<string[][]> {
  if (demoEnabled()) return demoRead()
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Sheet1!A:D',
  })

  return (res.data.values as string[][]) || []
}
