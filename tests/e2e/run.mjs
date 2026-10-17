// End-to-end harness: runs the BUILT Electron app with a fake microphone (a
// synthesized spoken question) against local stand-ins for Deepgram and
// Anthropic, and checks the real pipeline: mic worklet -> Flux events ->
// session -> Claude stream -> TTS -> playback, plus interruption and cleanup.
//
//   npm run build && node tests/e2e/run.mjs <speech.wav> [scenario ...]
//
// It proves the integration works; it does NOT test real Deepgram/Claude
// quality or a real microphone.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { startFakes } from './fake-services.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wavPath = path.resolve(process.argv[2])
const wanted = process.argv.slice(3)
const DEBUG_PORT = 9444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) {
      await debugDump?.().catch(() => {})
      throw new Error(`timed out waiting for ${what}`)
    }
    await sleep(50)
  }
}

async function targets() {
  try {
    return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).filter((t) => t.type === 'page')
  } catch {
    return []
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else listeners.forEach((l) => l(m))
  }
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return {
    send,
    on: (l) => listeners.push(l),
    eval: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result?.result?.value
    },
    close: () => ws.close()
  }
}

const engineConsole = []
async function launch(fakes, extraEnv = {}) {
  const env = {
    ECHO_DEBUG_HOOKS: '1',
    ...process.env,
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    DEEPGRAM_API_KEY: 'test-deepgram-key',
    ECHO_DEEPGRAM_WS_BASE: `ws://127.0.0.1:${fakes.port}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakes.port}`,
    ...extraEnv
  }
  const logs = []
  const chromiumFlags = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--inspect=9342',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`
  ]
  // E2E_DEV=1 runs through the Vite dev server (npm run dev) instead of the built app.
  const child = process.env.E2E_DEV
    ? spawn(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--', ...chromiumFlags], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(electronPath, [root, ...chromiumFlags], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))

  debugDump = async () => {
    console.log('  --- debug ---')
    console.log('  states:', (await page.eval('window.__ev')).filter(([, e]) => e.type === 'state').map(([, e]) => e.snapshot.state + (e.snapshot.message ? '(' + e.snapshot.message + ')' : '')).join(','))
    const l = fakes.log
    console.log('  flux:', JSON.stringify({ ...l.flux, frameSizes: [...l.flux.frameSizes] }))
    console.log('  tts:', JSON.stringify({ ...l.tts, speaks: l.tts.speaks.length }))
    console.log('  claude:', l.claude.requests.length, 'aborted', l.claude.aborted)
    console.log('  entries:', JSON.stringify((await page.eval('window.__ev')).filter(([, e]) => e.type === 'entry').map(([, e]) => e.entry).slice(-4)))
    console.log('  app log tail:', logs.join('').split('\n').slice(-15).join('\n'))
    console.log('  engine console tail:', engineConsole.slice(-12).join('\n    '))
  }
  const companion = await until(async () => (await targets()).find((t) => t.title === 'Companion'), 30000, 'companion window')
  const page = await connect(companion.webSocketDebuggerUrl)
  await page.eval(`window.__ev = []; window.voice.onEvent((e) => window.__ev.push([Date.now(), e])); true`)
  return {
    child,
    page,
    logs,
    events: async () => await page.eval('window.__ev'),
    states: async () => (await page.eval('window.__ev')).filter(([, e]) => e.type === 'state').map(([, e]) => e.snapshot.state),
    click: async (label) => {
      const sel = `[aria-label="${label}"]`
      await until(() => page.eval(`!!document.querySelector('${sel}')`), 10000, `button ${label}`)
      return page.eval(`document.querySelector('${sel}').click(); true`)
    },
    cmd: (c) => page.eval(`window.voice.command(${JSON.stringify(c)}); true`),
    engineTargets: async () => (await targets()).filter((t) => t.title === 'ECHO audio engine'),
    async quit() {
      page.close()
      child.kill()
      await sleep(500)
      if (process.platform === 'win32') spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
    }
  }
}

let debugDump = null
// --- Whiteboard access through the main-process inspector (ECHO_DEBUG_HOOKS=1) ---------------------
async function mainEval(expression) {
  const list = await (await fetch('http://127.0.0.1:9342/json')).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  const out = await new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data))
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (out.result?.exceptionDetails) throw new Error(JSON.stringify(out.result.exceptionDetails).slice(0, 300))
  return out.result?.result?.value
}
const sceneSummary = () =>
  mainEval(`__echoBoard.getScene().then((s) => ({
    viewport: s.viewport,
    elements: s.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height, opacity: e.opacity, text: e.text, containerId: e.containerId, echo: e.customData && e.customData.echo ? e.customData.echo : null, points: e.points || null, startBinding: e.startBinding ? e.startBinding.elementId : null, endBinding: e.endBinding ? e.endBinding.elementId : null, bound: (e.boundElements || []).map((b) => b.id) }))
  }))`)

// The tutor writes its drawing inside the segment, before the narration.
const withDraw = (segment, plan) => segment.replace('<say>', `<draw>${JSON.stringify(plan)}</draw><say>`)
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`)
}

const scenarios = {
  async pipeline() {
    console.log('\n[pipeline] one spoken question -> one spoken answer')
    const fakes = await startFakes({ tokenDelayMs: 20 })
    const app = await launch(fakes)
    try {
      await app.click('Start conversation')
      const engine = await until(async () => (await app.engineTargets())[0], 15000, 'engine window')
      const engineConn = await connect(engine.webSocketDebuggerUrl)
      const consoleLines = []
      engineConn.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
      })
      await engineConn.send('Runtime.enable')

      await until(async () => (await app.states()).includes('listening'), 20000, 'listening state')
      check('session reaches listening (mic + Flux connected)', true)
      await until(async () => (await app.states()).includes('speaking'), 40000, 'speaking state')
      await until(async () => {
        const s = await app.states()
        return s.lastIndexOf('listening') > s.lastIndexOf('speaking')
      }, 40000, 'back to listening')
      const states = await app.states()
      const order = ['connecting', 'listening', 'user-speaking', 'thinking', 'speaking', 'listening']
      let at = -1
      const inOrder = order.every((s) => (at = states.indexOf(s, at + 1)) >= 0)
      check('state sequence connecting>listening>user-speaking>thinking>speaking>listening', inOrder, states.join(','))

      const l = fakes.log
      check('mic frames are 80 ms (2560 bytes) of PCM16 and reach Flux', l.flux.frames > 10 && [...l.flux.frameSizes].join() === '2560', [...l.flux.frameSizes].join())
      check('Flux URL declares linear16 / 16000 Hz', /encoding=linear16/.test(l.flux.url[0]) && /sample_rate=16000/.test(l.flux.url[0]), l.flux.url[0])
      check('TTS URL declares linear16 / 24000 Hz', /encoding=linear16/.test(l.tts.url[0]) && /sample_rate=24000/.test(l.tts.url[0]), l.tts.url[0])
      check('Deepgram auth uses one key for STT and TTS', l.flux.auth[0] === 'Token test-deepgram-key' && l.tts.auth[0] === l.flux.auth[0])
      check('exactly one Claude request', l.claude.requests.length === 1, String(l.claude.requests.length))
      const req = l.claude.requests[0]
      check('Claude request: haiku model, streaming, thinking disabled, tutor system prompt', req.model === 'claude-haiku-5-5' && req.stream === true && req.thinking?.type === 'disabled' && /You are ECHO/.test(String(req.system)), JSON.stringify({ m: req.model, s: req.stream, t: req.thinking }))
      check('Claude got the complete user question', req.messages.at(-1).content === 'Can you explain how a variable works in programming?', JSON.stringify(req.messages))
      check('Claude API key sent as header only', l.claude.keyHeader[0] === 'test-anthropic-key')
      check('text sent to TTS in phrases (not tokens), flushes <= phrases', l.tts.speaks.length >= 1 && l.tts.speaks.every((t) => t.length > 8) && l.tts.flushes >= 1 && l.tts.flushes <= l.tts.speaks.length, JSON.stringify({ speaks: l.tts.speaks.length, flushes: l.tts.flushes }))
      check('local VAD (Silero) initialised in the engine window', consoleLines.some((x) => x.includes('local VAD ready')), consoleLines.join(' | ').slice(0, 300))
      check('no local-VAD failure warning', !consoleLines.some((x) => x.includes('local VAD unavailable')), consoleLines.join(' | ').slice(0, 300))

      const evs = await app.events()
      const metrics = evs.map(([, e]) => e).filter((e) => e.type === 'metrics' && e.metrics.firstAudioPlayed !== undefined)
      check('dev metrics reported (first Claude text / TTS audio / audio played)', metrics.length >= 1 && metrics[0].metrics.firstClaudeText !== undefined && metrics[0].metrics.firstTtsAudio !== undefined, JSON.stringify(metrics[0]))
      if (metrics[0]) console.log('        metrics (fake services, local):', JSON.stringify(metrics[0].metrics))
      const entries = evs.map(([, e]) => e).filter((e) => e.type === 'entry')
      const last = entries.filter((e) => e.entry.role === 'assistant').at(-1)?.entry
      check('assistant text shown and fully spoken', !!last && last.final && last.spokenChars === last.text.length && last.text.includes('named box'), JSON.stringify(last))
      check('no API keys in app logs', !app.logs.join('').includes('test-anthropic-key') && !app.logs.join('').includes('test-deepgram-key'))

      // Ending the conversation releases everything.
      await app.click('End conversation')
      await until(async () => (await app.engineTargets()).length === 0, 8000, 'engine window closed')
      await until(async () => fakes.log.flux.closed >= 1 && fakes.log.tts.closed >= 1, 8000, 'sockets closed')
      check('ending the session closes engine window (mic), STT and TTS sockets', true)
      engineConn.close()
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async interrupt() {
    console.log('\n[interrupt] barge-in while ECHO speaks, then follow-up with context')
    const long = ['Variables are named boxes that hold values. ', 'You can read them whenever you like. ', 'You can also change them whenever you like. ', 'Programs use them to remember things between steps. ', 'Without variables every calculation would be forgotten immediately. ']
    const fakes = await startFakes({ replyText: [long, ['Sure. Think of it as a labelled box.']], tokenDelayMs: 140, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      // First turn is driven by Flux events from the fake (the fake mic is idle for the first 2 s).
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'Explain' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'Explain variables to me', trigger: 'model' })
      await until(async () => (await app.states()).includes('speaking'), 20000, 'speaking')
      await sleep(1800) // let part of the first sentence play
      const clearsBefore = fakes.log.tts.clears
      const t0 = Date.now()
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: 'Wait explain' })
      await until(async () => fakes.log.tts.clears > clearsBefore, 3000, 'TTS Clear')
      check('barge-in sends Clear to TTS', true)
      await until(async () => fakes.log.claude.aborted >= 1, 3000, 'Claude abort')
      check('barge-in aborts the Claude request', true)
      const stopMetric = await until(async () => (await app.events()).map(([, e]) => e).find((e) => e.type === 'metrics' && e.metrics.interruptToStop !== undefined), 3000, 'stop metric')
      check('interrupt -> playback silenced measured', stopMetric.metrics.interruptToStop < 250, JSON.stringify(stopMetric.metrics))
      console.log(`        interruption detected -> playback stopped: ${stopMetric.metrics.interruptToStop} ms (engine ack), round trip incl. IPC ~${Date.now() - t0} ms`)
      check('state moves to user-speaking', (await app.states()).at(-1) === 'user-speaking')
      check('no audio from the cancelled answer after Clear', fakes.log.tts.audioAfterClear === 0, String(fakes.log.tts.audioAfterClear))

      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 1, transcript: 'Wait, explain that more simply.', trigger: 'model' })
      await until(async () => fakes.log.claude.requests.length >= 2, 6000, 'second Claude request')
      const msgs = fakes.log.claude.requests[1].messages
      const asst = msgs.find((m) => m.role === 'assistant')
      const firstSentence = 'Variables are named boxes that hold values.'
      check(
        'follow-up keeps context: first question, only the heard part of the answer, then the new question',
        msgs.length === 3 &&
          msgs[0].content === 'Explain variables to me' &&
          firstSentence.startsWith(asst?.content ?? 'x') &&
          asst.content.length > 0 &&
          msgs[2].content === 'Wait, explain that more simply.',
        JSON.stringify(msgs)
      )
      console.log('        ECHO was heard saying: "' + asst?.content + '" (of: "' + long.join('').slice(0, 60) + '...")')
      await until(async () => (await app.states()).filter((s) => s === 'speaking').length >= 2, 20000, 'second answer spoken')
      check('second answer is spoken after the interruption', true)
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async controls() {
    console.log('\n[controls] mute, push-to-talk, stop button, restart')
    const fakes = await startFakes({ replyText: ['This is a fairly long answer so that there is time to press stop. ', 'It keeps going for a while with more sentences. ', 'And a few more words to be safe.'], autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')

      // Mute: frames keep flowing (keeps Flux alive) but carry silence.
      await sleep(700)
      const loudBefore = fakes.log.flux.loudFrames
      await app.cmd({ type: 'mute', muted: true })
      await sleep(300)
      const silentMark = fakes.log.flux.silentFrames
      const framesMark = fakes.log.flux.frames
      await sleep(1000)
      check('muted: frames still flow but are silent', fakes.log.flux.frames > framesMark + 5 && fakes.log.flux.silentFrames - silentMark >= fakes.log.flux.frames - framesMark - 1)
      check('muted state is reported', (await app.states()).at(-1) === 'paused')
      await app.cmd({ type: 'mute', muted: false })

      // Push-to-talk: mic closed until the button is held; releasing forces end of turn.
      await app.cmd({ type: 'push-to-talk-mode', enabled: true })
      await sleep(400)
      const forcedBefore = fakes.log.flux.forced
      await app.cmd({ type: 'talk', pressed: true })
      await sleep(200)
      await app.cmd({ type: 'talk', pressed: false })
      await until(async () => fakes.log.flux.forced > forcedBefore, 3000, 'ForceEndTurn')
      check('push-to-talk release sends ForceEndTurn to Flux', true)
      await until(async () => fakes.log.claude.requests.length >= 1, 6000, 'Claude request after PTT')
      check('push-to-talk turn is answered', true)
      await app.cmd({ type: 'push-to-talk-mode', enabled: false })

      // Stop button.
      await until(async () => (await app.states()).filter((s) => s === 'speaking').length >= 1, 20000, 'speaking')
      const clears = fakes.log.tts.clears
      await app.cmd({ type: 'interrupt' })
      await until(async () => fakes.log.tts.clears > clears, 3000, 'Clear after stop')
      await until(async () => (await app.states()).at(-1) === 'listening', 3000, 'listening after stop')
      check('stop button silences ECHO and returns to listening', true)

      // End then start again: one engine window, a fresh pair of sockets, nothing left over.
      const fluxConns = fakes.log.flux.connections
      await app.click('End conversation')
      await until(async () => (await app.engineTargets()).length === 0, 8000, 'engine gone')
      await app.click('Start conversation')
      await until(async () => (await app.engineTargets()).length === 1, 8000, 'engine back')
      await until(async () => {
        const s = await app.states()
        return s.at(-1) === 'listening' && s.filter((x) => x === 'connecting').length >= 2
      }, 20000, 'listening again')
      check('restart creates exactly one new engine window and one new Flux socket', (await app.engineTargets()).length === 1 && fakes.log.flux.connections === fluxConns + 1, `${fakes.log.flux.connections} vs ${fluxConns}`)
      check('previous sockets were closed', fakes.log.flux.closed >= 1 && fakes.log.tts.closed >= 1)
      void loudBefore
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async vad() {
    console.log('\n[vad] local Silero VAD ducks ECHO when the (fake) mic hears speech, and sustained speech stops it even if STT never confirms')
    const long = Array.from({ length: 6 }, (_, i) => 'This is sentence number ' + (i + 1) + ' of a fairly long spoken answer. ')
    // autoTurns off: Flux never confirms the speech, so this was only a local-VAD trigger (like a cough or echo).
    const fakes = await startFakes({ replyText: long, tokenDelayMs: 30, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start conversation')
      const eng = await until(async () => (await app.engineTargets())[0], 15000, 'engine window')
      const engConn = await connect(eng.webSocketDebuggerUrl)
      engConn.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled') engineConsole.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
      })
      await engConn.send('Runtime.enable')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'Tell me' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'Tell me something long', trigger: 'model' })
      await until(async () => (await app.states()).includes('speaking'), 20000, 'speaking')
      await until(async () => app.logs.join('').includes('local VAD: speech while ECHO is speaking'), 12000, 'VAD detection while speaking')
      check('Silero VAD detected the mic speech while ECHO was speaking (and ducked locally)', true)
      // Flux (the fake) never reports a turn: sustained local speech alone must stop ECHO.
      await until(async () => fakes.log.tts.clears >= 1, 8000, 'TTS Clear from local barge-in')
      check('sustained local speech stops ECHO without any Deepgram turn event (TTS Clear sent)', true)
      check('barge-in was triggered by the local detector', app.logs.join('').includes('interrupt (local-vad-sustained)'))
      check('no audio from the cancelled answer after Clear', fakes.log.tts.audioAfterClear === 0)
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async ui() {
    console.log('\n[ui] screenshots of the lesson-window dock and pet while ECHO speaks (E2E_SHOT_DIR)')
    const dir = process.env.E2E_SHOT_DIR
    const fs = await import('node:fs')
    const long = Array.from({ length: 5 }, (_, i) => 'This is sentence number ' + (i + 1) + ' of a fairly long spoken answer. ')
    const fakes = await startFakes({ replyText: long, tokenDelayMs: 60, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start lesson')
      const lesson = await until(async () => (await targets()).find((t) => t.title === 'Lesson'), 15000, 'lesson window')
      const lp = await connect(lesson.webSocketDebuggerUrl)
      await app.click('End conversation').catch(() => {})
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'Tell me' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: 'Tell me something long' })
      await sleep(400)
      const shot = async (name, page) => {
        if (!dir) return
        const r = await page.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(dir, name), Buffer.from(r.result.data, 'base64'))
      }
      await shot('lesson-user-speaking.png', lp)
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'Tell me something long', trigger: 'model' })
      await until(async () => (await app.states()).includes('speaking'), 20000, 'speaking')
      await sleep(2500)
      await shot('lesson-speaking.png', lp)
      await shot('pet-speaking.png', app.page)
      const text = await lp.eval(`document.querySelector('.voice-dock')?.innerText ?? ''`)
      check('lesson dock shows the status, transcript and controls', /ECHO is speaking/.test(text) && /sentence number 1/.test(text) && /Talk to ECHO|End/.test(text), text.slice(0, 200))
      lp.close()
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async lesson() {
    console.log('\n[lesson] spoken explanation + whiteboard drawing in step, with the user\'s own drawing on the board')
    const dir = process.env.E2E_SHOT_DIR
    const fs = await import('node:fs')
    const SEG1 = '<segment><objective>How a page is fetched</objective><say>Your browser first asks a DNS server for the address. The DNS server answers with the number of the site. Then the browser requests the page from the web server.</say><visual>yes</visual><facts>- Browser asks DNS for the address\n- Browser requests the page from the web server</facts></segment>'
    const SEG2 = '<segment><objective>What comes back</objective><say>The web server sends back an HTML page that the browser displays.</say><visual>yes</visual></segment>'
    const plan1 = {
      setup: [{ op: 'diagram', id: 'web', title: 'Fetching a web page', layout: 'row', nodes: [{ id: 'browser', label: 'Browser' }, { id: 'dns', label: 'DNS server', detail: 'finds the address' }, { id: 'server', label: 'Web server' }], edges: [{ from: 'browser', to: 'dns', label: 'asks' }, { from: 'browser', to: 'server', label: 'requests page' }] }],
      cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['dns'] }] }, { sentence: 2, ops: [{ op: 'highlight', targets: ['server'] }] }]
    }
    const plan2 = {
      setup: [{ op: 'add', diagram: 'web', near: 'server', side: 'below', nodes: [{ id: 'html', label: 'HTML page' }], edges: [{ from: 'server', to: 'html', label: 'sends' }] }],
      cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['html'] }] }]
    }
    const fakes = await startFakes({ replyText: [[withDraw(SEG1, plan1), withDraw(SEG2, plan2)]], tokenDelayMs: 8, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start lesson')
      const lessonTarget = await until(async () => (await targets()).find((t) => t.title === 'Lesson'), 15000, 'lesson window')
      const lp = await connect(lessonTarget.webSocketDebuggerUrl)
      await until(async () => (await mainEval('typeof __echoBoard.getScene')) === 'function', 8000, 'board hook')
      await until(async () => (await sceneSummary().catch(() => null)) !== null, 15000, 'board ready')

      // The learner's own drawing is already on the board.
      await mainEval(`__echoBoard.upsertElements([{ id: 'user-sketch', type: 'rectangle', x: 40, y: 180, width: 220, height: 120, backgroundColor: '#fff3bf', strokeColor: '#e0b100', label: { text: 'my idea' } }])`)
      const userBefore = (await sceneSummary()).elements.find((e) => e.id === 'user-sketch')

      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      const tAsk = Date.now()
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'How' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'How does a browser get a web page?', trigger: 'model' })

      // Poll the live board, recording when things appear relative to when ECHO started speaking.
      const seen = {}
      let spokeAt = null
      let shotSetup = false
      const timeline = []
      for (let i = 0; i < 400; i++) {
        const scene = await sceneSummary()
        const ids = new Set(scene.elements.map((e) => e.id))
        const states = await app.states()
        if (spokeAt === null && states.includes('speaking')) spokeAt = Date.now()
        for (const id of ['echo:browser', 'echo:hl_dns', 'echo:hl_server', 'echo:html', 'echo:hl_html']) {
          if (ids.has(id) && seen[id] === undefined) {
            seen[id] = Date.now()
            timeline.push([id, seen[id] - tAsk, spokeAt ? seen[id] - spokeAt : null, JSON.stringify([scene.viewport.zoom, Math.round(scene.viewport.scrollX), Math.round(scene.viewport.scrollY)])])
          }
        }
        if (dir && !shotSetup && ids.has('echo:browser')) {
          shotSetup = true
          await sleep(900) // let the camera finish animating to the new diagram
          fs.writeFileSync(path.join(dir, 'lesson-1-setup.png'), Buffer.from((await lp.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
        }
        if (dir && ids.has('echo:hl_server') && !seen.__shot2) {
          seen.__shot2 = true
          await sleep(500)
          fs.writeFileSync(path.join(dir, 'lesson-2-highlight.png'), Buffer.from((await lp.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
        }
        const s = await app.states()
        if (ids.has('echo:html') && s.lastIndexOf('listening') > s.lastIndexOf('speaking') && s.includes('speaking')) break
        await sleep(100)
      }
      console.log('        timeline (ms since question / since speech began):', JSON.stringify(timeline))

      const scene = await sceneSummary()
      const byId = new Map(scene.elements.map((e) => [e.id, e]))
      const nodes = ['browser', 'dns', 'server', 'html'].map((n) => byId.get('echo:' + n))
      check('every node the tutor mentioned was drawn', nodes.every(Boolean), JSON.stringify(nodes.map(Boolean)))
      const labelOf = (id) => scene.elements.find((e) => e.containerId === id)?.text
      check('nodes carry their labels (bound text)', labelOf('echo:browser') === 'Browser' && /DNS server/.test(labelOf('echo:dns') ?? '') && labelOf('echo:server') === 'Web server', JSON.stringify([labelOf('echo:browser'), labelOf('echo:dns')]))
      const arrows = scene.elements.filter((e) => e.type === 'arrow' && e.echo?.kind === 'edge')
      check('arrows were drawn and bound to the right nodes', arrows.length === 3 && arrows.every((a) => a.startBinding && a.endBinding) && arrows.some((a) => a.startBinding === 'echo:browser' && a.endBinding === 'echo:dns'), JSON.stringify(arrows.map((a) => [a.startBinding, a.endBinding])))
      check('arrow labels are present', ['asks', 'requests page', 'sends'].every((l) => scene.elements.some((e) => e.text === l)))
      const rects = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }))
      let overlap = false
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlap = true
      }
      check('no overlapping nodes on the real canvas', !overlap)
      // Geometry of what Excalidraw really rendered: arrows must not pass through nodes, labels must not touch lines or nodes.
      const segHits = (a, b, r, pad) => {
        const x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad
        let t0 = 0, t1 = 1
        const dx = b.x - a.x, dy = b.y - a.y
        for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]]) {
          if (p === 0) { if (q < 0) return false } else { const t = q / p; if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t } }
        }
        return true
      }
      const nodeEls = ['browser', 'dns', 'server', 'html'].map((n) => ({ id: 'echo:' + n, x: byId.get('echo:' + n).x, y: byId.get('echo:' + n).y, w: byId.get('echo:' + n).w, h: byId.get('echo:' + n).h }))
      let thru = []
      let lblOnLine = []
      let lblOnNode = []
      for (const a of scene.elements.filter((e) => e.type === 'arrow' && e.echo?.kind === 'edge')) {
        const pts = a.points.map(([px, py]) => ({ x: a.x + px, y: a.y + py }))
        for (const n of nodeEls) {
          if (n.id === a.startBinding || n.id === a.endBinding) continue
          for (let i = 0; i < pts.length - 1; i++) if (segHits(pts[i], pts[i + 1], n, 0)) thru.push(a.id + ' x ' + n.id)
        }
        const lbl = scene.elements.find((e) => e.id === a.id + ':label')
        if (lbl) {
          const box = { x: lbl.x, y: lbl.y, w: lbl.w, h: lbl.h }
          for (let i = 0; i < pts.length - 1; i++) if (segHits(pts[i], pts[i + 1], box, 1)) lblOnLine.push(`${lbl.text} box=${JSON.stringify(box)} line=${JSON.stringify(pts)}`)
          for (const n of nodeEls) if (box.x < n.x + n.w && box.x + box.w > n.x && box.y < n.y + n.h && box.y + box.h > n.y) lblOnNode.push(lbl.text + ' on ' + n.id)
        }
      }
      check('no arrow passes through a node it does not connect', thru.length === 0, thru.join(', '))
      check('no arrow label touches its own line or any node', lblOnLine.length === 0 && lblOnNode.length === 0, JSON.stringify({ lblOnLine, lblOnNode }))
      const title = scene.elements.find((e) => e.id === 'echo:web:title')
      const arrowPts = scene.elements.filter((e) => e.type === 'arrow' && e.echo?.kind === 'edge').flatMap((a) => a.points.map(([px, py]) => ({ x: a.x + px, y: a.y + py })))
      check('nothing collides with the diagram title', !!title && !scene.elements.some((e) => e.id.includes(':label') && e.x < title.x + title.w && e.x + e.w > title.x && e.y < title.y + title.h && e.y + e.h > title.y), 'title/label overlap')
      void arrowPts
      const cam = scene.viewport
      check('the camera did not move for content that fit in view (the user\'s sketch stays visible)', cam.zoom === 1 && cam.scrollX === 0 && cam.scrollY === 0, JSON.stringify({ zoom: cam.zoom, scrollX: cam.scrollX, scrollY: cam.scrollY }))
      const user = byId.get('user-sketch')
      check("the user's own drawing is untouched and not claimed by the lesson", !!user && user.x === userBefore.x && user.y === userBefore.y && user.echo === null)
      check('the lesson did not draw over the user\'s sketch', nodes.every((n) => !(n.x < user.x + user.w && n.x + n.w > user.x && n.y < user.y + user.h && n.y + n.h > user.y)))
      check('all drawn elements are tagged as lesson-owned with a segment id', scene.elements.filter((e) => e.id.startsWith('echo:') && e.type !== 'text').every((e) => e.echo && e.echo.seg))

      // Timing: the diagram exists before ECHO speaks; highlights follow playback, one sentence at a time.
      check('the diagram was on the board before speech started', seen['echo:browser'] !== undefined && spokeAt !== null && seen['echo:browser'] <= spokeAt + 50, JSON.stringify({ drew: seen['echo:browser'] - tAsk, spoke: spokeAt - tAsk }))
      check('highlight for sentence 2 came after speech started and before the one for sentence 3', seen['echo:hl_dns'] >= spokeAt && seen['echo:hl_server'] > seen['echo:hl_dns'], JSON.stringify(timeline))
      const gap = seen['echo:hl_server'] - seen['echo:hl_dns']
      check('cues are spaced by real audio durations (not fired together)', gap > 1200, `gap ${gap}ms`)
      check('the next segment\'s drawing only appeared when the previous segment reached its last sentence', seen['echo:html'] >= seen['echo:hl_server'] - 100, JSON.stringify(timeline))
      const logs = app.logs.join('')
      const m = logs.match(/\[lesson\] metrics (\{[^\n]*"segmentId":"s1"[^\n]*\})/)
      const metrics = m ? JSON.parse(m[1]) : null
      check('dev metrics reported (drawing check, setup applied, audio start, cue delays)', !!metrics && metrics.mode === 'visual' && metrics.cueDelaysMs?.length === 2, m?.[1] ?? 'none')
      if (metrics) console.log('        s1 metrics:', JSON.stringify(metrics))
      if (metrics?.cueDelaysMs) check('cues were applied within 250 ms of their audio starting', metrics.cueDelaysMs.every((d) => d < 250), JSON.stringify(metrics.cueDelaysMs))

      // After the explanation, highlights are cleaned away.
      await until(async () => !(await sceneSummary()).elements.some((e) => e.id.startsWith('echo:hl_')), 8000, 'highlights cleared')
      check('highlight rings are removed when the explanation ends, the diagram stays', (await sceneSummary()).elements.some((e) => e.id === 'echo:browser'))
      check('one tutor request writes both narration and drawing: no second model call', fakes.log.claude.requests.length === 1 && !fakes.log.claude.requests[0].tools && /LESSON MODE/.test(String(fakes.log.claude.requests[0].system)), String(fakes.log.claude.requests.length))
      check('no keys in logs', !logs.includes('test-anthropic-key'))
      lp.close()
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async lessonInterrupt() {
    console.log('\n[lessonInterrupt] interrupting stops speech AND pending drawing; what is drawn stays')
    const SEG1 = '<segment><objective>How a page is fetched</objective><say>Your browser first asks a DNS server for the address. The DNS server answers with the number of the site. Then the browser requests the page from the web server.</say><visual>yes</visual></segment>'
    const SEG2 = '<segment><objective>What comes back</objective><say>The web server sends back an HTML page that the browser displays.</say><visual>yes</visual></segment>'
    const plan1 = {
      setup: [{ op: 'diagram', id: 'web', layout: 'row', nodes: [{ id: 'browser', label: 'Browser' }, { id: 'dns', label: 'DNS server' }, { id: 'server', label: 'Web server' }], edges: [{ from: 'browser', to: 'dns', label: 'asks' }] }],
      cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['dns'] }] }, { sentence: 2, ops: [{ op: 'highlight', targets: ['server'] }] }]
    }
    const plan2 = { setup: [{ op: 'add', diagram: 'web', near: 'server', side: 'below', nodes: [{ id: 'html', label: 'HTML page' }] }], cues: [] }
    const fakes = await startFakes({ replyText: [[withDraw(SEG1, plan1), withDraw(SEG2, plan2)], ['<segment><objective>x</objective><say>Sure, the browser asks DNS for the address first, nothing else.</say></segment>']], tokenDelayMs: 8, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start lesson')
      await until(async () => (await targets()).find((t) => t.title === 'Lesson'), 15000, 'lesson window')
      await until(async () => (await sceneSummary().catch(() => null)) !== null, 15000, 'board ready')
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'How' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'How does a browser get a web page?', trigger: 'model' })
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:hl_dns'), 20000, 'first highlight')
      const clears = fakes.log.tts.clears
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: 'Wait' })
      await until(async () => fakes.log.tts.clears > clears, 3000, 'TTS clear')
      const before = await sceneSummary()
      await sleep(5500) // longer than the next sentence would take
      const after = await sceneSummary()
      check('speech stopped immediately (TTS cleared, no audio after clear)', fakes.log.tts.audioAfterClear === 0)
      check('the highlight for the NEXT sentence never appeared after the interruption', !after.elements.some((e) => e.id === 'echo:hl_server'))
      check('the next segment was never released: its drawing did not appear (no stale drawing)', !after.elements.some((e) => e.id === 'echo:html'))
      check('everything already shown stays on the board', ['browser', 'dns', 'server'].every((n) => after.elements.some((e) => e.id === 'echo:' + n)))
      check('the board did not change at all after the interruption', after.elements.length === before.elements.length)
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 1, transcript: 'Wait, just tell me about the DNS part.', trigger: 'model' })
      await until(() => fakes.log.claude.requests.filter((r) => !r.tools).length >= 2, 8000, 'follow-up tutor request')
      const follow = fakes.log.claude.requests.filter((r) => !r.tools)[1]
      const lastMsg = follow.messages.at(-1).content
      check('the follow-up tutor request carries the board and where the user cut in', /lesson_context/.test(lastMsg) && /Fetching|diagram/i.test(lastMsg) && /interrupted during s1/.test(lastMsg), lastMsg.slice(-500))
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async lessonChart() {
    console.log('\n[lessonChart] a chart is drawn from the tutor-supplied numbers only, with units and source')
    const dir = process.env.E2E_SHOT_DIR
    const fs = await import('node:fs')
    const SEG = '<segment><objective>Falling speed</objective><data id="speed" label="Falling speed" unit="m/s" x_label="Seconds" illustrative="false" source="physics textbook">\n0: 0\n1: 9.8\n2: 19.6\n3: 29.4\n</data><say>A falling object speeds up steadily. After three seconds it is moving much faster than after one.</say></segment>'
    const plan = { setup: [{ op: 'chart', id: 'fall', data: 'speed', kind: 'line', title: 'Falling speed' }], cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['fall'] }] }] }
    const fakes = await startFakes({ replyText: [[withDraw(SEG, plan)]], tokenDelayMs: 8, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start lesson')
      const lessonTarget = await until(async () => (await targets()).find((t) => t.title === 'Lesson'), 15000, 'lesson window')
      const lp = await connect(lessonTarget.webSocketDebuggerUrl)
      await until(async () => (await sceneSummary().catch(() => null)) !== null, 15000, 'board ready')
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'How' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'How does falling speed change over time?', trigger: 'model' })
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:fall__yaxis'), 20000, 'chart drawn')
      await sleep(800)
      const scene = await sceneSummary()
      const texts = scene.elements.filter((e) => e.type === 'text').map((e) => e.text)
      for (const v of ['0', '9.8', '19.6', '29.4']) check(`value ${v} is labelled on the chart`, texts.includes(v))
      check('the unit and axis titles are shown', texts.includes('Falling speed (m/s)') && texts.includes('Seconds'))
      check('the source is shown and the data is NOT marked illustrative', texts.includes('Source: physics textbook') && !texts.some((t) => /Illustrative/.test(t ?? '')))
      check('a marker per data point and a connecting line', scene.elements.filter((e) => e.id.includes('__dot')).length === 4 && scene.elements.some((e) => e.id === 'echo:fall__line'))
      console.log('        chart line geometry:', JSON.stringify(scene.elements.filter((e) => /__(xaxis|yaxis|line|grid)/.test(e.id)).map((e) => [e.id.replace('echo:fall__', ''), Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h)])))
      console.log('        ring:', JSON.stringify(scene.elements.filter((e) => e.id.startsWith('echo:hl_')).map((e) => [Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h)])))
      const untagged = scene.elements.filter((e) => e.id.startsWith('echo:') && !e.echo).map((e) => e.id + ':' + e.type)
      check('every chart element (lines, dots, labels) is tagged as lesson-owned', untagged.length === 0, untagged.slice(0, 6).join(', '))
      const dots = scene.elements.filter((e) => e.id.includes('__dot')).sort((a, b) => a.x - b.x)
      const base = scene.elements.find((e) => e.id === 'echo:fall__xaxis')
      const hs = dots.map((d) => base.y - (d.y + 6))
      check('point heights are proportional to the supplied values', Math.abs(hs[2] / hs[1] - 2) < 0.05 && Math.abs(hs[3] / hs[1] - 3) < 0.05, JSON.stringify(hs))
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:hl_fall'), 15000, 'chart highlight cue')
      check('the chart is highlighted when the narration reaches it (block-level highlight)', true)
      if (dir) {
        await sleep(400)
        fs.writeFileSync(path.join(dir, 'lesson-chart.png'), Buffer.from((await lp.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
      }
      lp.close()
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async lessonCode() {
    console.log('\n[lessonCode] code cards are drawn line by line, lines light up with the narration, and Run shows real output')
    const dir = process.env.E2E_SHOT_DIR
    const fs = await import('node:fs')
    const SEG = '<segment><objective>A loop adds numbers</objective><say>We start the total at zero. The loop then adds each number to it. Finally we print the result.</say></segment>'
    const py = { op: 'code', id: 'loop_demo', title: 'A for loop', language: 'python', lines: ['total = 0', 'for n in range(1, 4):', '    total += n', '    print("added", n)', '', 'print("total is", total)'] }
    const js = { op: 'code', id: 'js_demo', language: 'javascript', lines: ['const xs = [1, 2, 3]', 'console.log(xs.map((x) => x * 2))', 'console.log(missing)'] }
    const plan = { setup: [py, js], cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['loop_demo__l3'] }] }] }
    const fakes = await startFakes({ replyText: [[withDraw(SEG, plan)]], tokenDelayMs: 8, autoTurns: false })
    const app = await launch(fakes)
    try {
      await app.click('Start lesson')
      const lessonTarget = await until(async () => (await targets()).find((t) => t.title === 'Lesson'), 15000, 'lesson window')
      const lp = await connect(lessonTarget.webSocketDebuggerUrl)
      await until(async () => (await sceneSummary().catch(() => null)) !== null, 15000, 'board ready')
      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'How' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'How does a for loop add numbers up?', trigger: 'model' })
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:loop_demo__l6__text'), 20000, 'code card drawn')
      const scene = await sceneSummary()
      const lineIds = scene.elements.filter((e) => e.echo?.kind === 'line' && e.echo.block === 'loop_demo').map((e) => e.echo.id)
      check('one highlightable line per source line', lineIds.join() === 'loop_demo__l1,loop_demo__l2,loop_demo__l3,loop_demo__l4,loop_demo__l5,loop_demo__l6', lineIds.join())
      check('indentation is kept in the drawn code', scene.elements.find((e) => e.id === 'echo:loop_demo__l3__text')?.text === '    total += n')
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:hl_loop_demo__l3'), 20000, 'line highlight cue')
      check('line 3 lights up when the narration reaches it', true)

      const buttons = await until(async () => {
        const n = await lp.eval(`document.querySelectorAll('.code-run-button').length`)
        return n === 2 ? n : null
      }, 10000, 'two Run buttons')
      check('both runnable cards get a Run button', buttons === 2)
      const outText = async (block) => (await sceneSummary()).elements.find((e) => e.id === `echo:${block}__out_text`)
      const runAndWait = async (index, block) => {
        await lp.eval(`document.querySelectorAll('.code-run-button')[${index}].click(); true`)
        return until(async () => {
          const el = await outText(block)
          return el?.echo?.detail === 'ran' ? el : null
        }, 60000, `${block} output`)
      }
      const titles = await lp.eval(`[...document.querySelectorAll('.code-run-button')].map((b) => b.title)`)
      const pyIndex = titles.findIndex((t) => /Python/.test(t))
      const pyOut = await runAndWait(pyIndex, 'loop_demo')
      check('Python runs in the board (Pyodide) and its real output replaces the placeholder', pyOut.text === 'added 1\nadded 2\nadded 3\ntotal is 6', JSON.stringify(pyOut.text))
      const jsOut = await runAndWait(1 - pyIndex, 'js_demo')
      check('JavaScript output is shown, followed by the error', /^\[2,4,6\]\nReferenceError: missing is not defined$/.test(jsOut.text), JSON.stringify(jsOut.text))
      if (dir) {
        await sleep(400)
        fs.writeFileSync(path.join(dir, 'lesson-code.png'), Buffer.from((await lp.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
      }
      lp.close()
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async lessonReopen() {
    console.log('\n[lessonReopen] closing and reopening the lesson window: no duplicate sessions, listeners or drawings')
    const SEG1 = '<segment><objective>How a page is fetched</objective><say>Your browser first asks a DNS server for the address. The DNS server answers with the number of the site. Then the browser requests the page from the web server.</say><visual>yes</visual></segment>'
    const SEG2 = '<segment><objective>What comes back</objective><say>The web server sends back an HTML page that the browser displays.</say><visual>yes</visual></segment>'
    const SEGB = '<segment><objective>Caching</objective><say>Browsers keep a copy of pages they have already seen. That makes the next visit much faster.</say><visual>yes</visual></segment>'
    const plan1 = { setup: [{ op: 'diagram', id: 'web', layout: 'row', nodes: [{ id: 'browser', label: 'Browser' }, { id: 'dns', label: 'DNS server' }, { id: 'server', label: 'Web server' }], edges: [{ from: 'browser', to: 'dns', label: 'asks' }] }], cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['dns'] }] }] }
    const plan2 = { setup: [{ op: 'add', diagram: 'web', near: 'server', side: 'below', nodes: [{ id: 'html', label: 'HTML page' }] }], cues: [] }
    const planB = { setup: [{ op: 'add', diagram: 'web', near: 'browser', side: 'below', nodes: [{ id: 'cache', label: 'Cache' }], edges: [{ from: 'browser', to: 'cache', label: 'keeps a copy' }] }], cues: [] }
    const fakes = await startFakes({ replyText: [[withDraw(SEG1, plan1), withDraw(SEG2, plan2)], [withDraw(SEGB, planB)]], tokenDelayMs: 8, autoTurns: false })
    const app = await launch(fakes)
    const lessonTargets = async () => (await targets()).filter((t) => t.title === 'Lesson')
    try {
      // Open, close, open again.
      await app.click('Start lesson')
      let lt = await until(async () => (await lessonTargets())[0], 15000, 'lesson window')
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${lt.id}`)
      await until(async () => (await lessonTargets()).length === 0, 8000, 'lesson window closed')
      await app.click('Start lesson')
      await until(async () => (await lessonTargets()).length === 1, 15000, 'lesson window reopened')
      check('reopening gives exactly one lesson window', (await lessonTargets()).length === 1)
      await until(async () => (await sceneSummary().catch(() => null)) !== null, 15000, 'board ready')

      await app.click('Start conversation')
      await until(async () => (await app.states()).includes('listening'), 20000, 'listening')
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 0, transcript: 'How' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'How does a browser get a web page?', trigger: 'model' })
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:hl_dns'), 20000, 'first highlight')

      // Close the window in the middle of the lesson.
      lt = (await lessonTargets())[0]
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${lt.id}`)
      await until(async () => (await lessonTargets()).length === 0, 8000, 'window closed mid-lesson')
      await until(async () => {
        const s = await app.states()
        return s.lastIndexOf('listening') > s.lastIndexOf('speaking') && s.includes('speaking')
      }, 40000, 'the explanation finishes verbally')
      check('closing the window mid-lesson does not break the voice conversation (it finishes verbally)', (await app.states()).at(-1) === 'listening')
      check('only one speech-recognition and one voice-output socket exist', fakes.log.flux.connections === 1 && fakes.log.tts.connections === 1, `${fakes.log.flux.connections}/${fakes.log.tts.connections}`)
      check('the app is still responsive after the window closed', (await targets()).some((t) => t.title === 'Companion'))

      // Reopen: the board comes back with exactly what was drawn, and a follow-up extends it.
      await app.click('Start lesson')
      await until(async () => (await lessonTargets()).length === 1, 15000, 'lesson window reopened again')
      await until(async () => (await sceneSummary().catch(() => ({ elements: [] }))).elements.some((e) => e.id === 'echo:browser'), 15000, 'diagram restored')
      const restored = await sceneSummary()
      const dupes = (els) => els.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i)
      check('the reopened board shows the diagram that was drawn before, without duplicates', restored.elements.some((e) => e.id === 'echo:dns') && dupes(restored.elements).length === 0, dupes(restored.elements).join())
      fakes.fluxSend({ type: 'TurnInfo', event: 'StartOfTurn', turn_index: 1, transcript: 'And' })
      fakes.fluxSend({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 1, transcript: 'And what about caching?', trigger: 'model' })
      await until(async () => (await sceneSummary()).elements.some((e) => e.id === 'echo:cache'), 30000, 'follow-up drawing')
      const after = await sceneSummary()
      check('the follow-up extended the existing diagram once (no duplicated elements, existing nodes untouched)', dupes(after.elements).length === 0 && after.elements.filter((e) => e.id === 'echo:browser').length === 1 && after.elements.find((e) => e.id === 'echo:browser').x === restored.elements.find((e) => e.id === 'echo:browser').x, dupes(after.elements).join())
      check('still a single voice session', fakes.log.flux.connections === 1 && (await lessonTargets()).length === 1)
    } finally {
      await app.quit()
      await fakes.close()
    }
  },

  async missingKeys() {
    console.log('\n[missingKeys] empty credentials')
    const fakes = await startFakes()
    const app = await launch(fakes, { ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '' })
    try {
      await app.click('Start conversation')
      const ev = await until(async () => (await app.events()).map(([, e]) => e).find((e) => e.type === 'state' && e.snapshot.state === 'error'), 8000, 'error state')
      check('missing keys produce a clear error naming the variables', /ANTHROPIC_API_KEY/.test(ev.snapshot.message) && /DEEPGRAM_API_KEY/.test(ev.snapshot.message), ev.snapshot.message)
      check('no engine window / mic opened without credentials', (await app.engineTargets()).length === 0)
    } finally {
      await app.quit()
      await fakes.close()
    }
  }
}

const names = wanted.length ? wanted : Object.keys(scenarios)
for (const n of names) {
  try {
    await scenarios[n]()
  } catch (err) {
    check(`${n}: ${err.message}`, false)
  }
  await sleep(1000)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
