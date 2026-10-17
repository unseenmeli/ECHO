import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as messages } from '../backend/api/anthropic/v1/messages'
import { POST as deepgramToken } from '../backend/api/deepgram/token'
import { GET as usage } from '../backend/api/usage'
import { usageTap, validateMessagesRequest, readPolicy } from '../backend/lib/anthropic'
import { authenticate, parseAccessCodes } from '../backend/lib/auth'
import { MemoryStore } from '../backend/lib/counters'
import { admitClaudeRequest, admitDeepgramToken, readLimits } from '../backend/lib/limits'
import { ACCESS_CODE_REJECTED, backendDeepgramAuth, DeepgramAuthError } from '../src/main/voice/backend'
import { ClaudeChat } from '../src/main/voice/claude'
import { ACCESS_CODE_MISSING, readVoiceConfig } from '../src/main/voice/config'
import { ChatError } from '../src/main/voice/ports'

const enc = new TextEncoder()

/** A streamed Messages reply, split into chunks that cut lines in half (as the network does). */
function sseChunks(text = ['Hello', ' there.']): Uint8Array[] {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }
  ]
  const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const out: Uint8Array[] = []
  for (let i = 0; i < raw.length; i += 37) out.push(enc.encode(raw.slice(i, i + 37)))
  return out
}

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch)
      c.close()
    }
  })

let upstream: ReturnType<typeof vi.fn>
let codeSeq = 0
/** A fresh access code per test, so the shared in-memory counters don't carry over between tests. */
let code = ''

beforeEach(() => {
  code = `CODE-${++codeSeq}-${Math.random().toString(36).slice(2)}`
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-server')
  vi.stubEnv('DEEPGRAM_API_KEY', 'dg-server')
  vi.stubEnv('ECHO_ACCESS_CODES', `judge-${codeSeq}:${code}`)
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('KV_REST_API_URL', '')
  vi.stubEnv('VERCEL_ENV', '')
  upstream = vi.fn(async () => new Response(streamOf(sseChunks()), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' } }))
  vi.stubGlobal('fetch', upstream)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const body = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }], ...over })

const post = (b: string, auth = code, signal?: AbortSignal): Request =>
  new Request('https://echo.test/api/anthropic/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: b, signal })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('access codes', () => {
  it('parses labelled and bare codes, and checks the bearer token', () => {
    const list = parseAccessCodes(' judge-1:AAAA-BBBB , CCCC-DDDD ,, empty: ')
    expect(list.map((e) => e.label)).toEqual(['judge-1', expect.stringMatching(/^code-[0-9a-f]{8}$/)])
    const req = (auth: string): Request => new Request('https://x.test', { headers: { authorization: auth } })
    expect(authenticate(req('Bearer AAAA-BBBB'), list)).toEqual({ label: 'judge-1' })
    expect(authenticate(req('Bearer nope'), list)).toBeNull()
    expect(authenticate(req('AAAA-BBBB'), list)).toBeNull()
  })
})

describe('what the proxy lets through', () => {
  const policy = readPolicy({})
  it('accepts what ECHO sends', () => {
    expect(
      validateMessagesRequest(
        {
          model: 'claude-sonnet-5-5',
          max_tokens: 21000,
          stream: true,
          system: [{ type: 'text', text: 'x' }],
          messages: [],
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          tools: [{ name: 'draft_message', input_schema: {} }, { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]
        },
        policy
      )
    ).toEqual({ ok: true, model: 'claude-sonnet-5-5', stream: true })
  })
  it.each([
    [{ model: 'claude-fable-5-1' }, /Model not allowed/],
    [{ max_tokens: 100000 }, /max_tokens/],
    [{ fallbacks: 'default' }, /"fallbacks" is not allowed/],
    [{ tools: [{ type: 'computer_toolset_20260801' }] }, /computer_toolset/],
    [{ tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 50 }] }, /max_uses/],
    [{ output_config: { task_budget: { type: 'tokens', total: 1 } } }, /task_budget/]
  ])('refuses %j', (over, message) => {
    const r = validateMessagesRequest({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [], ...over }, policy)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(message)
  })
})

describe('usage limits', () => {
  it('counts requests per minute, per day and overall, and stops at the token budget', async () => {
    const store = new MemoryStore()
    const limits = { ...readLimits({}), requestsPerMinute: 2, requestsPerDay: 3, outputTokensPerDay: 10 }
    const t = Date.UTC(2026, 9, 18, 12, 0, 5)
    expect((await admitClaudeRequest(store, 'a', limits, t)).ok).toBe(true)
    expect((await admitClaudeRequest(store, 'a', limits, t)).ok).toBe(true)
    expect(await admitClaudeRequest(store, 'a', limits, t)).toMatchObject({ ok: false, retryAfter: 55 })
    expect(await admitClaudeRequest(store, 'a', limits, t + 60_000)).toMatchObject({ ok: false, message: expect.stringMatching(/requests for today/) })
    expect((await admitClaudeRequest(store, 'b', limits, t)).ok).toBe(true) // other codes are unaffected
    await store.incr(`echo:2026-10-18:b:output`, 10, 60)
    expect(await admitClaudeRequest(store, 'b', limits, t)).toMatchObject({ ok: false, message: expect.stringMatching(/tokens/) })
  })

  it('limits Deepgram tokens per day', async () => {
    const store = new MemoryStore()
    const limits = { ...readLimits({}), deepgramTokensPerDay: 1 }
    expect((await admitDeepgramToken(store, 'a', limits)).ok).toBe(true)
    expect((await admitDeepgramToken(store, 'a', limits)).ok).toBe(false)
  })

  it('reads usage out of a stream without changing it', async () => {
    let seen = { input: 0, output: 0 }
    const tap = usageTap((u) => (seen = u))
    const out = new Uint8Array(await new Response(streamOf(sseChunks()).pipeThrough(tap.stream)).arrayBuffer())
    const original = new Uint8Array(await new Response(streamOf(sseChunks())).arrayBuffer())
    expect(out).toEqual(original)
    expect(seen).toEqual({ input: 150, output: 7 })
  })
})

describe('the Messages proxy', () => {
  it('streams the reply through, with the server key and without the access code', async () => {
    const res = await messages(post(body()))
    expect(res.status).toBe(200)
    expect(res.headers.get('request-id')).toBe('req_1')
    expect(await res.text()).toContain('"text":" there."')
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-server')
    expect(JSON.stringify(init.headers)).not.toContain(code)
    await flush()
    const summary = await (await usage(new Request('https://echo.test/api/usage', { headers: { authorization: `Bearer ${code}` } }))).json()
    expect(summary.used).toMatchObject({ requests: 1, inputTokens: 150, outputTokens: 7 })
  })

  it('refuses a wrong code, a disallowed model, and an oversized body before calling Anthropic', async () => {
    expect((await messages(post(body(), 'wrong'))).status).toBe(401)
    const bad = await messages(post(body({ model: 'claude-fable-5-1' })))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.type).toBe('invalid_request_error')
    expect((await messages(post('x'.repeat(4_500_000)))).status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('cancels the Anthropic request when the app hangs up, and still counts the tokens', async () => {
    let upstreamSignal: AbortSignal | undefined
    upstream.mockImplementation(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined
      // The first part of a reply (message_start included), then nothing: the model is still writing.
      const head = sseChunks().slice(0, 12)
      return new Response(new ReadableStream({ start: (c) => head.forEach((ch) => c.enqueue(ch)) }), { status: 200 })
    })
    const app = new AbortController()
    const res = await messages(post(body(), code, app.signal))
    const reader = res.body!.getReader()
    for (let i = 0; i < 12; i++) await reader.read()
    app.abort()
    await flush()
    expect(upstreamSignal?.aborted).toBe(true)
    const summary = await (await usage(new Request('https://echo.test/api/usage', { headers: { authorization: `Bearer ${code}` } }))).json()
    expect(summary.used.inputTokens).toBe(150)
  })

  it('passes Anthropic errors through unchanged', async () => {
    upstream.mockResolvedValue(Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }))
    const res = await messages(post(body()))
    expect(res.status).toBe(529)
    expect((await res.json()).error.message).toBe('Overloaded')
  })
})

describe('ECHO talking to the proxy', () => {
  /** ECHO's real Claude client, with its HTTP requests handed straight to the proxy function. */
  function chatVia(accessCode: string): ClaudeChat {
    const cfg = readVoiceConfig({ ECHO_BACKEND_URL: 'https://echo.test', ECHO_ACCESS_CODE: accessCode })
    if (!cfg.ok) throw new Error(cfg.message)
    const client = new Anthropic({
      baseURL: 'https://echo.test/api/anthropic',
      apiKey: null,
      authToken: accessCode,
      maxRetries: 0,
      fetch: (url, init) => messages(new Request(url as string, init as RequestInit))
    })
    return new ClaudeChat(cfg.config, client, () => {})
  }
  const ask = (chat: ClaudeChat, onText: (t: string) => void, signal = new AbortController().signal) =>
    chat.stream({ system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], signal, onText })

  it('streams text', async () => {
    let text = ''
    await ask(chatVia(code), (d) => (text += d))
    expect(text).toBe('Hello there.')
  })

  it('reports a rejected access code and a reached limit in plain words', async () => {
    await expect(ask(chatVia('wrong'), () => {})).rejects.toEqual(new ChatError('auth', ACCESS_CODE_REJECTED))
    vi.stubEnv('ECHO_LIMIT_REQUESTS_PER_DAY', '0')
    const err = await ask(chatVia(code), () => {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChatError)
    expect((err as ChatError).kind).toBe('rate-limit')
    expect((err as ChatError).message).toMatch(/requests for today/)
  })
})

describe('Deepgram tokens', () => {
  it('grants a short-lived token to a valid code only', async () => {
    upstream.mockResolvedValue(Response.json({ access_token: 'jwt-1', expires_in: 60 }))
    const tokenReq = (auth: string): Request => new Request('https://echo.test/api/deepgram/token', { method: 'POST', headers: { authorization: `Bearer ${auth}` } })
    expect((await deepgramToken(tokenReq('wrong'))).status).toBe(401)
    const res = await deepgramToken(tokenReq(code))
    expect(await res.json()).toEqual({ access_token: 'jwt-1', expires_in: 60 })
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://api.deepgram.com/v1/auth/grant')
    expect(init.headers.Authorization).toBe('Token dg-server')
  })

  it('the app reuses a token until shortly before it expires, and stops on a rejected code', async () => {
    let now = 0
    const fetchImpl = vi.fn(async () => Response.json({ access_token: `jwt-${fetchImpl.mock.calls.length}`, expires_in: 60 }))
    const auth = backendDeepgramAuth({ url: 'https://echo.test', accessCode: code }, fetchImpl as unknown as typeof fetch, () => now)
    expect(await Promise.all([auth.header(), auth.header()])).toEqual(['Bearer jwt-1', 'Bearer jwt-1'])
    now = 50_000
    expect(await auth.header()).toBe('Bearer jwt-2')
    const rejected = backendDeepgramAuth({ url: 'https://echo.test', accessCode: 'x' }, (async () => new Response(null, { status: 401 })) as unknown as typeof fetch)
    await expect(rejected.header()).rejects.toEqual(new DeepgramAuthError(ACCESS_CODE_REJECTED, true))
  })
})

describe('app configuration', () => {
  it('needs no provider keys with a server, only an access code', () => {
    const r = readVoiceConfig({ ECHO_BACKEND_URL: 'https://echo.example.com/', ECHO_ACCESS_CODE: 'C' })
    expect(r.ok && r.config.backend).toEqual({ url: 'https://echo.example.com', accessCode: 'C' })
    expect(r.ok && r.config.anthropicApiKey).toBe('')
    expect(readVoiceConfig({ ECHO_BACKEND_URL: 'https://echo.example.com' })).toEqual({ ok: false, message: ACCESS_CODE_MISSING })
    expect(readVoiceConfig({ ECHO_BACKEND_URL: 'http://echo.example.com', ECHO_ACCESS_CODE: 'C' }).ok).toBe(false)
    expect(readVoiceConfig({ ECHO_BACKEND_URL: 'http://localhost:3000', ECHO_ACCESS_CODE: 'C' }).ok).toBe(true)
    const direct = readVoiceConfig({ ANTHROPIC_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' })
    expect(direct.ok && direct.config.backend).toBeNull()
  })
})
