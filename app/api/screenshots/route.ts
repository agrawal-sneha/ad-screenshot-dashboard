import { NextResponse } from 'next/server'
import { getSheetData } from '@/lib/google'

export async function GET() {
  try {
    const rows = await getSheetData()
    // Skip header row if present
    const data = rows.length > 0 && rows[0][0]?.toLowerCase() === 'date' ? rows.slice(1) : rows
    return NextResponse.json({ rows: data.reverse() }) // newest first
  } catch (err) {
    console.error('Fetch error:', err)
    const message = err instanceof Error ? err.message : 'Failed to fetch'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
