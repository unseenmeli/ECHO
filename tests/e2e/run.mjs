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
      spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
    }
  }
}

let debugDump = null
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
