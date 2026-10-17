// Emails and posts ECHO writes for the user. Nothing is ever sent by ECHO: on the user's yes, the app opens the
// destination's own compose page with the draft filled in, and the user presses send there.

export type DestinationId = 'gmail' | 'mail' | 'x' | 'linkedin'

export const DESTINATIONS: Record<DestinationId, { label: string; kind: 'email' | 'post' }> = {
  gmail: { label: 'Gmail', kind: 'email' },
  mail: { label: 'Mail', kind: 'email' },
  x: { label: 'X', kind: 'post' },
  linkedin: { label: 'LinkedIn', kind: 'post' }
}

export const DESTINATION_IDS = Object.keys(DESTINATIONS) as DestinationId[]

export function isDestination(v: unknown): v is DestinationId {
  return typeof v === 'string' && Object.hasOwn(DESTINATIONS, v)
}

export interface Draft {
  id: string
  destination: DestinationId
  /** Email only: comma-separated addresses (may be empty for the user to fill in). */
  to: string
  /** Email only. */
  subject: string
  body: string
}

/** Fields the user may change in the draft card. */
export type DraftEdits = Partial<Pick<Draft, 'to' | 'subject' | 'body'>>

export const MAX_BODY = 20000
const MAX_FIELD = 500
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/

/** The addresses in `to` that look like email addresses; anything else is dropped. */
export function cleanRecipients(to: unknown): string {
  if (typeof to !== 'string') return ''
  return to
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter((a) => EMAIL.test(a))
    .join(', ')
    .slice(0, MAX_FIELD)
}

/** Validates edits arriving from the draft card. */
export function parseDraftEdits(raw: unknown): DraftEdits | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: DraftEdits = {}
  if (typeof r.to === 'string') out.to = r.to.slice(0, MAX_FIELD)
  if (typeof r.subject === 'string') out.subject = r.subject.slice(0, MAX_FIELD)
  if (typeof r.body === 'string') out.body = r.body.slice(0, MAX_BODY)
  return out
}

/** The destination's compose page with the draft filled in. */
export function composeUrl(d: Draft): string {
  const enc = encodeURIComponent
  const to = cleanRecipients(d.to)
  switch (d.destination) {
    case 'gmail':
      return `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(d.subject)}&body=${enc(d.body)}`
    case 'mail':
      return `mailto:${to.replace(/\s+/g, '')}?subject=${enc(d.subject)}&body=${enc(d.body.replace(/\r?\n/g, '\r\n'))}`
    case 'x':
      return `https://x.com/intent/post?text=${enc(d.body)}`
    case 'linkedin':
      return `https://www.linkedin.com/feed/?shareActive=true&text=${enc(d.body)}`
  }
}
