import { NextResponse } from 'next/server'
import { repo } from '@th/db'

export const runtime = 'nodejs'
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix']

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const status = String(body.status || '')
  if (!STATUSES.includes(status)) {
    return NextResponse.json({ ok: false, error: 'bad_status' }, { status: 400 })
  }
  const ok = repo.setStatus(id, status)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
