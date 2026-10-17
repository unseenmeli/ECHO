// What the Messages proxy lets through, and how it reads token usage out of a streamed reply.

export interface ProxyPolicy {
  models: string[]
  maxOutputTokens: number
  maxServerToolUses: number
}

export function readPolicy(env: Record<string, string | undefined> = process.env): ProxyPolicy {
  const models = (env.ECHO_ALLOWED_MODELS ?? 'claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  const n = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Math.max(1, Math.floor(Number(v))) : d)
  return { models, maxOutputTokens: n(env.ECHO_MAX_OUTPUT_TOKENS, 24_000), maxServerToolUses: n(env.ECHO_MAX_SERVER_TOOL_USES, 10) }
}

/** Request fields ECHO sends. Anything else (other betas' parameters, fallbacks to other models, ...) is refused. */
const ALLOWED_FIELDS = new Set([
  'model',
  'max_tokens',
  'system',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'metadata',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'cache_control'
])

/** Anthropic-hosted tools ECHO uses. Computer use, bash, MCP and the rest are refused. */
const SERVER_TOOL = /^(?:web_search|web_fetch|code_execution)_\d{8}$/

export type Validation = { ok: true; model: string; stream: boolean } | { ok: false; message: string }

export function validateMessagesRequest(body: unknown, policy: ProxyPolicy): Validation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'The request body must be a JSON object.' }
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, message: `The field "${key}" is not allowed through the ECHO server.` }
  }
  if (typeof b.model !== 'string' || !policy.models.includes(b.model)) {
    return { ok: false, message: `Model not allowed. Allowed: ${policy.models.join(', ')}.` }
  }
  if (typeof b.max_tokens !== 'number' || b.max_tokens < 1 || b.max_tokens > policy.maxOutputTokens) {
    return { ok: false, message: `max_tokens must be between 1 and ${policy.maxOutputTokens}.` }
  }
  if (b.output_config !== undefined) {
    if (!b.output_config || typeof b.output_config !== 'object') return { ok: false, message: 'output_config must be an object.' }
    for (const key of Object.keys(b.output_config)) {
      if (key !== 'effort' && key !== 'format') return { ok: false, message: `output_config.${key} is not allowed through the ECHO server.` }
    }
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return { ok: false, message: 'tools must be an array.' }
    for (const tool of b.tools as Array<Record<string, unknown>>) {
      const type = tool?.type
      if (type === undefined || type === 'custom') continue
      if (typeof type !== 'string' || !SERVER_TOOL.test(type)) return { ok: false, message: `Tool type "${String(type)}" is not allowed through the ECHO server.` }
      if (typeof tool.max_uses === 'number' && tool.max_uses > policy.maxServerToolUses) {
        return { ok: false, message: `Tool max_uses must be at most ${policy.maxServerToolUses}.` }
      }
    }
  }
  return { ok: true, model: b.model, stream: b.stream === true }
}

export interface Usage {
  input: number
  output: number
}

type RawUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** Folds one usage object into the running total. Streamed counts are cumulative, so keep the largest seen. */
export function mergeUsage(into: Usage, u: RawUsage | undefined | null): void {
  if (!u) return
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  into.input = Math.max(into.input, input)
  into.output = Math.max(into.output, u.output_tokens ?? 0)
}

/**
 * Passes server-sent events through unchanged while reading the usage in `message_start` and `message_delta`.
 * `onDone` runs once: when the stream ends, or when the caller calls `finish` (the client went away), whichever
 * comes first.
 */
export function usageTap(onDone: (usage: Usage) => void): { stream: TransformStream<Uint8Array, Uint8Array>; finish: () => void } {
  const usage: Usage = { input: 0, output: 0 }
  const decoder = new TextDecoder()
  let pending = ''
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    onDone(usage)
  }
  const scan = (text: string): void => {
    pending += text
    let i: number
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim()
      pending = pending.slice(i + 1)
      if (!line.startsWith('data:') || !line.includes('"usage"')) continue
      try {
        const event = JSON.parse(line.slice(5)) as { type?: string; message?: { usage?: RawUsage }; usage?: RawUsage }
        if (event.type === 'message_start') mergeUsage(usage, event.message?.usage)
        else if (event.type === 'message_delta') mergeUsage(usage, event.usage)
      } catch {
        // Not JSON; ignore.
      }
    }
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      scan(decoder.decode(chunk, { stream: true }))
    },
    flush() {
      scan(decoder.decode() + '\n')
      finish()
    }
  })
  return { stream, finish }
}
