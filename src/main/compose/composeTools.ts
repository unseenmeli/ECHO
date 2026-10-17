import { cleanRecipients, DESTINATIONS, isDestination, MAX_BODY, type DestinationId, type Draft, type DraftEdits } from '../../shared/compose'
import type { ChatTool, ToolCall } from '../voice/ports'

/** The app side of drafting: show the card, and open the compose page once the user says yes. */
export interface ComposePort {
  /** Destinations the user allows, in order. Empty turns the feature off. */
  destinations: DestinationId[]
  /** Shows the draft card, or hides it (null). */
  show(draft: Draft | null): void
  /** Opens the destination's compose page with the draft filled in. */
  open(draft: Draft): void
}

export function composeTools(destinations: DestinationId[]): ChatTool[] {
  return [
    {
      name: 'draft_message',
      description:
        'Write an email or a social media post for the user and show it to them in a card with Send and Cancel buttons. Nothing is sent: if they say yes, the app opens the compose page with the draft filled in and they press send themselves. Call it again with the complete text to revise a draft.',
      input_schema: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            enum: destinations,
            description: `Where it goes: ${destinations.map((d) => `${d} (${DESTINATIONS[d].kind})`).join(', ')}.`
          },
          to: { type: 'string', description: 'Email only: recipient addresses, comma-separated. Leave empty if you only know a name.' },
          subject: { type: 'string', description: 'Email only: the subject line.' },
          body: { type: 'string', description: 'The full text of the email or post, ready to send.' }
        },
        required: ['destination', 'body']
      }
    }
  ]
}

/** Appended to the system prompt whenever the drafting tool is offered. */
export function composeGuide(destinations: DestinationId[]): string {
  const email = destinations.filter((d) => DESTINATIONS[d].kind === 'email')
  const post = destinations.filter((d) => DESTINATIONS[d].kind === 'post')
  const names = (ids: DestinationId[]): string => ids.map((d) => DESTINATIONS[d].label).join(' or ') || 'none'
  return `WRITING EMAILS AND POSTS

You can write an email or a social media post for the user with draft_message. The app shows the draft in a card with Send and Cancel buttons. You never send anything yourself: if the user says yes, the app opens the compose page with the draft filled in, and the user presses send there.
- Allowed destinations. Email: ${names(email)}. Posts: ${names(post)}. Nothing else is possible. If the user doesn't say where, use ${email[0] ? DESTINATIONS[email[0]].label : 'the first allowed destination'} for an email, and ask which site for a post.
- Call it only when the user asks you to write, draft or send an email, message or post. Write the complete text in the user's voice, from what they told you. Don't invent facts, dates, names or promises they didn't give; put a placeholder in square brackets for anything essential you don't know.
- For an email, put the recipient's address in "to" only if you know it. With just a name, leave "to" empty; the user can type it in the card.
- After calling it, say in one short sentence what you wrote, then ask whether to send it. Don't read the whole text aloud unless it's very short or they ask.
- If they ask for changes, call draft_message again with the complete revised text.
- Never say a message was sent or posted. On yes, the compose page opens and the user sends it.`
}

const SEND = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|send(?: it| that)?|post(?: it| that)?|looks (?:good|great|fine)|perfect|sounds good|that'?s (?:good|great|fine|perfect))\b[\s,.!]*)+(?:please|thanks|thank you)?[\s,.!]*$/i
const CANCEL = /^(?:(?:no|nope|nah|cancel(?: it| that)?|don'?t(?: send(?: it)?)?|do not send(?: it)?|never ?mind|forget it|scrap (?:it|that)|discard (?:it|that)|stop)\b[\s,.!]*)+(?:thanks|thank you|please)?[\s,.!]*$/i

export type DraftAnswer = { kind: 'sent'; spoken: string } | { kind: 'cancelled'; spoken: string }

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** Holds the one draft the user is looking at, and settles it on their yes or no. */
export class ComposeTools {
  private draft: Draft | null = null
  private seq = 0

  constructor(private readonly port: ComposePort) {}

  get pending(): Draft | null {
    return this.draft
  }

  reset(): void {
    if (this.draft) this.port.show(null)
    this.draft = null
  }

  /** The model's draft_message call. Returns the tool result note. */
  handle(call: ToolCall): string {
    const input = (call.input ?? {}) as Record<string, unknown>
    if (!isDestination(input.destination) || !this.port.destinations.includes(input.destination)) {
      return `not shown: that destination isn't allowed. Allowed: ${this.port.destinations.join(', ')}`
    }
    const body = str(input.body, MAX_BODY)
    if (!body) return 'not shown: the body was empty'
    const email = DESTINATIONS[input.destination].kind === 'email'
    this.draft = {
      id: `d${++this.seq}`,
      destination: input.destination,
      to: email ? cleanRecipients(input.to) : '',
      subject: email ? str(input.subject, 500) : '',
      body
    }
    this.port.show(this.draft)
    return `draft shown to the user in the card with Send and Cancel buttons${email && !this.draft.to ? ' (no recipient address yet; they can type it in)' : ''}. Say in one short sentence what you wrote and ask whether to send it`
  }

  /** The user changed the draft in the card. */
  edit(id: string, edits: DraftEdits): void {
    if (this.draft?.id !== id) return
    this.draft = { ...this.draft, ...edits }
  }

  /** Send or Cancel, from the card or from a spoken yes/no. */
  answer(id: string, send: boolean): DraftAnswer | null {
    const d = this.draft
    if (!d || d.id !== id) return null
    this.draft = null
    this.port.show(null)
    if (!send) return { kind: 'cancelled', spoken: "Okay, I won't send it." }
    this.port.open(d)
    const where = DESTINATIONS[d.destination].label
    return {
      kind: 'sent',
      spoken: `I opened ${where} with it filled in, and copied the text too. Just press ${DESTINATIONS[d.destination].kind === 'email' ? 'send' : 'post'}.`
    }
  }

  /**
   * Called with every finished user turn while a draft is shown. A short yes or no settles it; anything else (such
   * as "make it shorter") is an ordinary turn and the draft stays up (returns null).
   */
  resolveSpoken(transcript: string): DraftAnswer | null {
    const d = this.draft
    if (!d) return null
    const text = transcript.trim().replace(/\s+/g, ' ')
    if (!text || text.split(' ').length > 8) return null
    if (SEND.test(text)) return this.answer(d.id, true)
    if (CANCEL.test(text)) return this.answer(d.id, false)
    return null
  }

  /** What the model needs to know about the draft on screen, for the turn context. */
  turnNote(): string | null {
    const d = this.draft
    if (!d) return null
    const email = DESTINATIONS[d.destination].kind === 'email'
    const fields = email ? `To: ${d.to || '(empty)'}\nSubject: ${d.subject}\n\n${d.body}` : d.body
    return `<pending_draft destination="${DESTINATIONS[d.destination].label}">\n${fields}\n</pending_draft>\nThe user is looking at this draft (they may have edited it) with Send and Cancel buttons. To change it, call draft_message with the complete revised text.`
  }
}
