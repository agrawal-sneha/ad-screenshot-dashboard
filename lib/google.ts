import { google } from 'googleapis'
import { Readable } from 'stream'

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

export async function appendToSheet(row: string[]) {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Sheet1!A:D',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  })
}

export async function getSheetData(): Promise<string[][]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Sheet1!A:D',
  })

  return (res.data.values as string[][]) || []
}
