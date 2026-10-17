// Local stand-ins for Deepgram (Flux STT + streaming TTS) and the Anthropic
// Messages API, used ONLY by the end-to-end harness to exercise ECHO's real
// pipeline code without network access or credentials. They are not part of
// the app.
import http from 'node:http'
import { WebSocketServer } from 'ws'

const TTS_RATE = 24000

/** The one-word "close it, deepen it, or just answer?" check that precedes turns mentioning the lesson window. */
export const isRouterRequest = (r) => String(r.system ?? '').startsWith('You route one spoken request')
/** A tutor reply request. Tutor requests carry the preference tools; the old visuals planner carried plan_visuals. */
export const isTutorRequest = (r) => !isRouterRequest(r) && !(Array.isArray(r.tools) && r.tools.some((t) => t.name === 'plan_visuals'))

export async function startFakes(opts = {}) {
  const log = {
    flux: { connections: 0, closed: 0, auth: [], url: [], frames: 0, frameSizes: new Set(), silentFrames: 0, loudFrames: 0, forced: 0 },
    tts: { connections: 0, closed: 0, auth: [], url: [], speaks: [], flushes: 0, clears: 0, audioChunks: 0, audioAfterClear: 0 },
    claude: { requests: [], aborted: 0, completed: 0, keyHeader: [] }
  }
  const state = { fluxSocket: null, ttsSockets: new Set(), turn: 0 }
  const hooks = { onTtsAudio: null }

  // --- Flux -----------------------------------------------------------------
  const flux = new WebSocketServer({ noServer: true })
  flux.on('connection', (ws, req) => {
    log.flux.connections += 1
    log.flux.auth.push(req.headers.authorization ?? '')
    log.flux.url.push(req.url)
    state.fluxSocket = ws
    let loud = 0
    let quiet = 0
    let speaking = false
    let lastUpdate = 0
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o))
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString())
        if (m.type === 'ForceEndTurn') {
          log.flux.forced += 1
          send({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: state.turn, transcript: opts.userText ?? 'Can you explain how a variable works in programming?', trigger: 'manual' })
          state.turn += 1
        }
        return
      }
      log.flux.frames += 1
      log.flux.frameSizes.add(data.length)
      let sum = 0
      for (let i = 0; i + 1 < data.length; i += 2) {
        const v = data.readInt16LE(i)
        sum += v * v
      }
      const rms = Math.sqrt(sum / (data.length / 2))
      if (rms < 1) log.flux.silentFrames += 1
      if (rms > 500) {
        loud += 1
        quiet = 0
        log.flux.loudFrames += 1
      } else {
        quiet += 1
        if (!speaking) loud = 0
      }
      if (opts.autoTurns !== false) {
        if (!speaking && loud >= 3) {
          speaking = true
          send({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: state.turn, transcript: 'Can you' })
        } else if (speaking && quiet >= 9) {
          speaking = false
          loud = 0
          send({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: state.turn, transcript: opts.userText ?? 'Can you explain how a variable works in programming?', end_of_turn_confidence: 0.9, trigger: 'model' })
          state.turn += 1
        } else if (speaking && Date.now() - lastUpdate > 250) {
          lastUpdate = Date.now()
          send({ type: 'TurnInfo', event: 'Update', turn_index: state.turn, transcript: 'Can you explain how a' })
        }
      }
    })
    ws.on('close', () => {
      log.flux.closed += 1
      if (state.fluxSocket === ws) state.fluxSocket = null
    })
  })

  // --- TTS ------------------------------------------------------------------
  const tts = new WebSocketServer({ noServer: true })
  tts.on('connection', (ws, req) => {
    log.tts.connections += 1
    log.tts.auth.push(req.headers.authorization ?? '')
    log.tts.url.push(req.url)
    state.ttsSockets.add(ws)
    let pendingText = ''
    let cleared = false
    let seq = 0
    let timer = null
    const jobs = []
    const runNext = () => {
      if (timer || !jobs.length) return
      const { samples, seq: mySeq } = jobs.shift()
      let sent = 0
      timer = setInterval(() => {
        const n = Math.min(Math.round(TTS_RATE * 0.06), samples - sent)
        // Odd byte lengths on purpose: real frames can split a 16-bit sample.
        const buf = Buffer.alloc(n * 2)
        for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(((sent + i) / TTS_RATE) * 2 * Math.PI * 220) * 6000), i * 2)
        const half = Math.floor(buf.length / 2) | 1
        if (cleared) log.tts.audioAfterClear += 1
        ws.send(buf.subarray(0, half))
        ws.send(buf.subarray(half))
        log.tts.audioChunks += 2
        hooks.onTtsAudio?.()
        sent += n
        if (sent >= samples) {
          stopTimer()
          send({ type: 'Flushed', sequence_id: mySeq })
          runNext()
        }
      }, 20)
    }
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o))
    const stopTimer = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.type === 'Speak') {
        pendingText += m.text
        log.tts.speaks.push(m.text)
      } else if (m.type === 'Flush') {
        log.tts.flushes += 1
        const chars = pendingText.length
        pendingText = ''
        // ~15 chars per second of speech, streamed at 3x real time. Flushes run in order, like the real service.
        jobs.push({ samples: Math.round(Math.max(0.5, chars / 15) * TTS_RATE), seq: seq++ })
        runNext()
      } else if (m.type === 'Clear') {
        log.tts.clears += 1
        stopTimer()
        jobs.length = 0
        cleared = true
        pendingText = ''
        send({ type: 'Cleared', sequence_id: seq })
        cleared = false
      }
    })
    ws.on('close', () => {
      stopTimer()
      log.tts.closed += 1
      state.ttsSockets.delete(ws)
    })
  })

  // --- Anthropic ------------------------------------------------------------------
  const replyFor = opts.replyText ?? ['A variable is a named box that holds a value. ', 'You can change what is inside it later. ', 'For example, age can be ten today and eleven next year.']
  const web = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      log.claude.requests.push(parsed)
      log.claude.keyHeader.push(req.headers['x-api-key'] ?? '')
      const index = log.claude.requests.length - 1
      if (Array.isArray(parsed.tools) && parsed.tools.some((t) => t.name === 'plan_visuals')) {
        // Visuals agent: a single non-streaming message carrying a tool_use block.
        log.claude.visualCalls = (log.claude.visualCalls ?? 0) + 1
        const plans = opts.visualPlans ?? []
        const call = log.claude.visualCalls - 1
        const step = plans[call] ?? { no_visual: true, setup: [], cues: [] }
        const delay = step.__delayMs ?? opts.visualDelayMs ?? 150
        const { __delayMs, ...input } = step
        setTimeout(() => {
          if (res.destroyed) return
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: 'msg_vis', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'tool_use', id: 'toolu_' + call, name: 'plan_visuals', input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }))
        }, delay)
        return
      }
      // Tutor requests offer only the preference tools; the quick lesson-routing check is its own kind of request.
      const isRouter = isRouterRequest(parsed)
      const tutorIndex = log.claude.requests.filter(isTutorRequest).length - 1
      const texts = isRouter ? ['ANSWER'] : Array.isArray(replyFor[0]) ? (replyFor[tutorIndex] ?? replyFor[replyFor.length - 1]) : replyFor
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      ev('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      let closed = false
      // Use the response's 'close': the request's fires as soon as the body has been read.
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true
          log.claude.aborted += 1
        }
      })
      const tokens = texts.flatMap((t) => t.match(/\S+\s*/g) ?? [])
      let i = 0
      const tick = () => {
        if (closed) return
        if (i < tokens.length) {
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tokens[i++] } })
          setTimeout(tick, opts.tokenDelayMs ?? 25)
        } else {
          ev('content_block_stop', { type: 'content_block_stop', index: 0 })
          ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: tokens.length } })
          ev('message_stop', { type: 'message_stop' })
          res.end()
          log.claude.completed += 1
        }
      }
      tick()
    })
  })

  web.on('upgrade', (req, socket, head) => {
    const wss = req.url?.startsWith('/v2/listen') ? flux : req.url?.startsWith('/v1/speak') ? tts : null
    if (!wss) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const port = web.address().port
  return {
    port,
    log,
    state,
    hooks,
    fluxSend: (o) => state.fluxSocket?.send(JSON.stringify(o)),
    close: () => new Promise((r) => web.close(() => r()))
  }
}
