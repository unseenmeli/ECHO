import Anthropic from '@anthropic-ai/sdk'
import type { VoiceConfig } from './config'
import type { ChatMessage } from './history'
import { ChatError, type ChatPort, type ChatRequest, type ScreenImage, type VoiceContext } from './ports'

export const TUTOR_SYSTEM_PROMPT = `You are ECHO, a friendly, clear, conversational tutor speaking out loud with the user.

How to answer:
- Answer the user's actual question directly, in the first sentence.
- Use short, natural spoken sentences. Everything you write is read aloud by a voice, so write for the ear.
- Start with a concise explanation. Go deeper only when the user asks.
- Explain unfamiliar terms in plain words and use a concrete example when it helps.
- Keep replies brief: usually two to five sentences. Never give a long monologue.
- No Markdown, headings, tables, bullet lists, code blocks, emoji or URLs. Spell out symbols the way you would say them.
- If the request is ambiguous, ask one short clarifying question instead of guessing.
- If your previous reply looks cut off, the user interrupted you. Don't repeat what they already heard; answer what they say next, and continue only if they ask you to.

Honesty:
- Do not invent facts, sources, screen content or whiteboard actions.
- You can only see the user's screen when a screenshot is attached to their latest message, and the whiteboard only when its state is provided below. Otherwise say you can't see it and offer to talk it through.`

/**
 * @param alreadySaid A filler line ECHO has already spoken for this turn
 *   (e.g. "Let me take a look!"), so the reply continues from it.
 */
export function buildSystemPrompt(context?: VoiceContext | null, alreadySaid?: string | null): string {
  if (!context?.screen && !context?.board && !alreadySaid) return TUTOR_SYSTEM_PROMPT
  const parts = [TUTOR_SYSTEM_PROMPT, '', 'Context supplied by the app for this turn:']
  if (context?.screen) parts.push(`<screen_context>\n${context.screen}\n</screen_context>`)
  if (context?.board) parts.push(`<whiteboard_state>\n${context.board}\n</whiteboard_state>`)
  if (alreadySaid) {
    parts.push(
      `<already_said>\n${alreadySaid}\n</already_said>`,
      "You just said the line above out loud. Continue straight on from it: don't repeat it, and don't say again that you're going to look."
    )
  }
  return parts.join('\n')
}

/** Puts the screenshot in front of the latest user message (images work best before the text). */
export function withImage(messages: ChatMessage[], image?: ScreenImage): Anthropic.MessageParam[] {
  const last = messages.at(-1)
  if (!image || last?.role !== 'user') return messages
  return [
    ...messages.slice(0, -1),
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text: last.content }
      ]
    }
  ]
}

function classify(err: unknown): ChatError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ChatError('auth', 'Anthropic rejected the API key (check ANTHROPIC_API_KEY).')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ChatError('rate-limit', 'Claude is rate limited right now. Try again in a moment.')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ChatError('network', 'Could not reach Claude. Check your connection.')
  }
  if (err instanceof Anthropic.APIError) {
    // err.message is the API's own description of the problem (it never contains the key).
    return new ChatError('other', `Claude returned an error (${err.status ?? 'unknown'}): ${err.message}`.slice(0, 300))
  }
  return new ChatError('other', 'Claude request failed.')
}

/** Streaming Claude conversation via the official Anthropic SDK. */
export class ClaudeChat implements ChatPort {
  private readonly client: Anthropic

  constructor(private readonly cfg: VoiceConfig) {
    // The SDK retries transient failures; keep that short so a voice turn doesn't stall.
    this.client = new Anthropic({
      apiKey: cfg.anthropicApiKey,
      maxRetries: 1,
      ...(cfg.anthropicWorkspaceId ? { defaultHeaders: { 'anthropic-workspace-id': cfg.anthropicWorkspaceId } } : {})
    })
  }

  async stream(req: ChatRequest): Promise<void> {
    const params = {
      model: this.cfg.claudeModel,
      max_tokens: this.cfg.claudeMaxTokens,
      system: req.system,
      messages: withImage(req.messages, req.image),
      ...(this.cfg.claudeDisableThinking ? { thinking: { type: 'disabled' as const } } : {})
    }
    try {
      await this.run(params, req)
    } catch (err) {
      if (req.signal.aborted) return
      // Some models reject `thinking: disabled`; fall back once without it.
      if (this.cfg.claudeDisableThinking && err instanceof Anthropic.BadRequestError && /thinking/i.test(err.message)) {
        const { thinking: _unused, ...rest } = params
        try {
          await this.run(rest, req)
          return
        } catch (retryErr) {
          if (req.signal.aborted) return
          throw classify(retryErr)
        }
      }
      throw classify(err)
    }
  }

  private async run(params: Anthropic.MessageStreamParams, req: ChatRequest): Promise<void> {
    const stream = this.client.messages.stream(params, { signal: req.signal })
    stream.on('text', (delta) => {
      if (!req.signal.aborted) req.onText(delta)
    })
    try {
      await stream.finalMessage()
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || req.signal.aborted) return
      throw err
    }
  }
}
