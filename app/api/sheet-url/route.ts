import { NextResponse } from 'next/server'

export async function GET() {
  const id = process.env.GOOGLE_SHEET_ID
  if (!id) return NextResponse.json({ error: 'Sheet not configured' }, { status: 500 })
  return NextResponse.json({ url: `https://docs.google.com/spreadsheets/d/${id}` })
}
