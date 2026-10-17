import { createHash, timingSafeEqual } from 'node:crypto'

// Judge access codes. ECHO_ACCESS_CODES lists them, comma-separated, each optionally labelled:
//   ECHO_ACCESS_CODES="judge-1:K7QP-M2XD-9WVA,judge-2:R4TN-8HCE-JZ3L"
// The label (or a hash of the code when there is none) is who usage is counted against, and what the logs show.

export interface Caller {
  label: string
}

interface CodeEntry {
  label: string
  digest: Buffer
}

const digest = (code: string): Buffer => createHash('sha256').update(code).digest()

export function parseAccessCodes(raw: string | undefined): CodeEntry[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const i = part.lastIndexOf(':')
      const label = i > 0 ? part.slice(0, i).trim() : ''
      const code = (i > 0 ? part.slice(i + 1) : part).trim()
      if (!code) return []
      return [{ label: label || `code-${digest(code).toString('hex').slice(0, 8)}`, digest: digest(code) }]
    })
}

let cache: { raw: string | undefined; entries: CodeEntry[] } | null = null

function entries(): CodeEntry[] {
  const raw = process.env.ECHO_ACCESS_CODES
  if (!cache || cache.raw !== raw) cache = { raw, entries: parseAccessCodes(raw) }
  return cache.entries
}

/** The access code from `Authorization: Bearer <code>`, checked in constant time against every configured code. */
export function authenticate(request: Request, list: CodeEntry[] = entries()): Caller | null {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  const given = digest(match[1].trim())
  let found: CodeEntry | null = null
  for (const e of list) if (timingSafeEqual(e.digest, given)) found = e
  return found ? { label: found.label } : null
}

export function accessCodeCount(): number {
  return entries().length
}
