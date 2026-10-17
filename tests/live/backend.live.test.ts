// The backend's Anthropic proxy against the real API: ECHO's Claude client → proxy function → api.anthropic.com.
// Uses ANTHROPIC_API_KEY from .env as the server's key. Costs a fraction of a cent.
//   ECHO_LIVE=1 npx vitest run tests/live/backend.live.test.ts

import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { POST as messages } from '../../backend/api/anthropic/v1/messages'
import { ClaudeChat } from '../../src/main/voice/claude'
import { loadEnvFiles, readVoiceConfig } from '../../src/main/voice/config'

loadEnvFiles([process.cwd()])
const live = process.env.ECHO_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY

describe.skipIf(!live)('backend proxy (live)', () => {
  it('streams a real reply, and a cancelled one stops', async () => {
    vi.stubEnv('ECHO_ACCESS_CODES', 'live:LIVE-CODE')
    vi.stubEnv('VERCEL_ENV', '')
    const cfg = readVoiceConfig({ ECHO_BACKEND_URL: 'https://echo.test', ECHO_ACCESS_CODE: 'LIVE-CODE' })
    if (!cfg.ok) throw new Error(cfg.message)
    const client = new Anthropic({
      baseURL: 'https://echo.test/api/anthropic',
      apiKey: null,
      authToken: 'LIVE-CODE',
      maxRetries: 0,
      fetch: (url, init) => messages(new Request(url as string, init as RequestInit))
    })
    const chat = new ClaudeChat(cfg.config, client, () => {})

    let text = ''
    await chat.stream({ system: 'Answer in one short sentence.', messages: [{ role: 'user', content: 'What colour is the sky on a clear day?' }], signal: new AbortController().signal, onText: (d) => (text += d) })
    expect(text).toMatch(/blue/i)

    const ctl = new AbortController()
    let partial = ''
    const started = Date.now()
    await chat.stream({
      system: 'Be thorough.',
      maxTokens: 2000,
      messages: [{ role: 'user', content: 'Count from 1 to 400 in words, one per line.' }],
      signal: ctl.signal,
      onText: (d) => {
        partial += d
        if (partial.length > 40) ctl.abort()
      }
    })
    expect(partial.length).toBeLessThan(400)
    expect(Date.now() - started).toBeLessThan(15_000)
    vi.unstubAllEnvs()
  }, 60_000)
})
