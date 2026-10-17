import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeChat } from '../src/main/voice/claude'
import { readVoiceConfig } from '../src/main/voice/config'
import type { ChatRequest, ChatResult } from '../src/main/voice/ports'

// The web fetch tool end to end through the real SDK, against a stand-in for api.anthropic.com.

type Body = Record<string, any>
const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

/** A streamed reply made of the given content blocks (text blocks may carry citations). */
function sse(model: string, blocks: Array<Record<string, any>>, usage: Record<string, unknown> = {}, stopReason = 'end_turn'): string {
  let out = ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, ...usage } } })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: block.citations ? [] : null } })
      for (const c of block.citations ?? []) out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: c } })
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else if (block.type === 'server_tool_use' || block.type === 'tool_use') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } })
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: block })
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index })
  })
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1, ...usage } })
  return out + ev('message_stop', { type: 'message_stop' })
}

function fakeApi(respond: (body: Body, n: number) => Response) {
  const bodies: Body[] = []
  const fetch = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return respond(body, bodies.length)
  }
  return { bodies, client: new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: fetch as never }) }
}
const ok = (text: string): Response => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })

function config(extra: Record<string, string> = {}) {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'test-key', DEEPGRAM_API_KEY: 'd', ECHO_CODE_EXECUTION: 'on', ...extra })
  if (!cfg.ok) throw new Error('config')
  return cfg.config
}

async function ask(chat: ClaudeChat, cfg: ReturnType<typeof config>, extra: Partial<ChatRequest> = {}) {
  let text = ''
  let result: ChatResult | null = null
  let fetchStarted = 0
  await chat.stream({
    system: 'You are ECHO.',
    messages: [{ role: 'user', content: 'What does the Python docs page on list comprehensions say?' }],
    webSearch: { maxUses: cfg.webSearchMaxUses },
    webFetch: { maxUses: cfg.webFetchMaxUses, maxContentTokens: cfg.webFetchMaxTokens },
    codeExecution: true,
    signal: new AbortController().signal,
    onText: (d) => (text += d),
    onResult: (r) => (result = r),
    onFetchStart: () => fetchStarted++,
    ...extra
  })
  return { text, result: result as ChatResult | null, fetchStarted }
}

describe('client tool calls', () => {
  it('sends the outcome back so the reply goes on after the call', async () => {
    const cfg = config()
    const call = { type: 'tool_use', id: 'toolu_1', name: 'remember_preference', input: { key: 'visualStyle', value: 'diagrams' } }
    const api = fakeApi((b, n) => ok(n === 1 ? sse(b.model, [call], {}, 'tool_use') : sse(b.model, [{ type: 'text', text: 'Saved. Now, recursion…' }])))
    const calls: unknown[] = []
    const { text } = await ask(new ClaudeChat(cfg, api.client, () => {}), cfg, {
      onToolUse: (c) => (calls.push(c), 'saved visualStyle')
    })
    expect(calls).toEqual([{ name: 'remember_preference', input: call.input }])
    expect(text).toBe('Saved. Now, recursion…')
    const sent = api.bodies[1].messages as Array<{ role: string; content: any }>
    expect(sent.at(-2)!.content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' })
    expect(sent.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
  })
})

describe('web fetch', () => {
  it('quick answers on the fast model get the basic search and fetch, next to code execution', async () => {
    const cfg = config()
    const api = fakeApi((b) => ok(sse(b.model, [{ type: 'text', text: 'Hi.' }])))
    await ask(new ClaudeChat(cfg, api.client, () => {}), cfg)
    const tools = api.bodies[0].tools as Array<Record<string, unknown>>
    expect(tools.map((t) => t.type)).toEqual(['web_search_20250305', 'web_fetch_20250910', 'code_execution_20260521'])
    expect(tools[1]).toEqual({ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, max_content_tokens: 8000, citations: { enabled: true } })
  })

  it('models with dynamic filtering get the matching fetch, and no separate code execution', async () => {
    const cfg = config()
    const api = fakeApi((b) => ok(sse(b.model, [{ type: 'text', text: 'Hi.' }])))
    await ask(new ClaudeChat(cfg, api.client, () => {}), cfg, { deep: true })
    expect(api.bodies[0].model).toBe('claude-sonnet-5-5')
    expect((api.bodies[0].tools as Array<{ type: string }>).map((t) => t.type)).toEqual(['web_search_20260209', 'web_fetch_20260209'])
  })

  it('is never offered without search, since it can only open URLs already in the conversation', async () => {
    const cfg = config()
    const api = fakeApi((b) => ok(sse(b.model, [{ type: 'text', text: 'Hi.' }])))
    await ask(new ClaudeChat(cfg, api.client, () => {}), cfg, { webSearch: undefined })
    expect((api.bodies[0].tools as Array<{ type: string }>).map((t) => t.type)).toEqual(['code_execution_20260521'])
  })

  it('credits a page it read and cited as a source, and reports a page it could not read', async () => {
    const cfg = config()
    const url = 'https://docs.python.org/3/tutorial/datastructures.html'
    const api = fakeApi((b) =>
      ok(
        sse(
          b.model,
          [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url } },
            { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result', url, retrieved_at: '2026-10-17T10:00:00Z', content: { type: 'document', title: 'Data Structures', citations: { enabled: true }, source: { type: 'text', media_type: 'text/plain', data: 'List comprehensions provide a concise way to create lists.' } } } },
            { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://blocked.example/' } },
            { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
            {
              type: 'text',
              text: 'They are a concise way to create lists.',
              citations: [{ type: 'char_location', cited_text: 'List comprehensions provide a concise way to create lists.', document_index: 0, document_title: 'Data Structures', start_char_index: 0, end_char_index: 58, file_id: null }]
            }
          ],
          { server_tool_use: { web_search_requests: 0, web_fetch_requests: 2 } }
        )
      )
    )
    const { text, result, fetchStarted } = await ask(new ClaudeChat(cfg, api.client, () => {}), cfg)
    expect(text).toBe('They are a concise way to create lists.')
    expect(fetchStarted).toBe(2)
    expect(result!.sources).toEqual([{ title: 'Data Structures', url, cited: true }])
    expect(result!.fetchErrors).toEqual(['url_not_accessible'])
    expect(result!.usage.fetches).toBe(2)
  })

  it('carries on without fetch when the API key may not use it', async () => {
    const cfg = config()
    const log: string[] = []
    const api = fakeApi((b, n) =>
      n === 1
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'web_fetch is not enabled for this organization' } }), { status: 400, headers: { 'content-type': 'application/json' } })
        : ok(sse(b.model, [{ type: 'text', text: 'From the search results, they build lists.' }]))
    )
    const chat = new ClaudeChat(cfg, api.client, (m) => log.push(m))
    const { text } = await ask(chat, cfg)
    expect(text).toBe('From the search results, they build lists.')
    expect((api.bodies[1].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['web_search', 'code_execution'])
    expect(log.join('\n')).toMatch(/web fetch is not available/)
    // Later requests don't ask for it again.
    await ask(chat, cfg)
    expect((api.bodies[2].tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['web_search', 'code_execution'])
  })
})
