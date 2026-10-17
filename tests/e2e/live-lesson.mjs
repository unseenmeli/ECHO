// LIVE check of the visual lesson against the REAL services, using the keys in .env (loaded by the app
// itself) and a fake microphone clip so your real mic isn't used. ECHO's reply WILL play through your speakers,
// and the question/answer text goes to Anthropic and Deepgram like any real session.
//
//   node tests/e2e/live-lesson.mjs <clip.wav> <screenshot-dir> [seconds]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wav = path.resolve(process.argv[2])
const shots = path.resolve(process.argv[3])
const seconds = Number(process.argv[4] || 60)
const PORT = 9556
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const child = spawn(electronPath, [root, `--remote-debugging-port=${PORT}`, '--inspect=9343', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`], {
  env: { ...process.env, ECHO_DEBUG_HOOKS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => ({ json: async () => [] }))).json()).filter((t) => t.type === 'page')
const wsFor = async (url) => {
  const ws = new WebSocket(url)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pend = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    pend.get(m.id)?.(m)
  }
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  return { send, eval: async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value, close: () => ws.close() }
}
const mainEval = async (expression) => {
  const list = await (await fetch('http://127.0.0.1:9343/json')).json()
  const c = await wsFor(list[0].webSocketDebuggerUrl)
  const v = await c.eval(expression)
  c.close()
  return v
}

let comp
for (let i = 0; i < 100 && !comp; i++) { comp = (await targets()).find((t) => t.title === 'Companion'); await sleep(200) }
const pet = await wsFor(comp.webSocketDebuggerUrl)
await pet.eval(`window.__ev=[];window.voice.onEvent(e=>window.__ev.push([Date.now(),e]));true`)
await sleep(500)
await pet.eval(`document.querySelector('[aria-label="Start lesson"]').click();true`)
let lessonT
for (let i = 0; i < 100 && !lessonT; i++) { lessonT = (await targets()).find((t) => t.title === 'Lesson'); await sleep(200) }
const lesson = await wsFor(lessonT.webSocketDebuggerUrl)
await sleep(2500)
const t0 = Date.now()
await pet.eval(`document.querySelector('[aria-label="Start conversation"]').click();true`)

const sceneJs = `__echoBoard.getScene().then((s) => s.elements.filter((e) => e.customData && e.customData.echo && e.type !== 'text').map((e) => ({ id: e.id, type: e.type, kind: e.customData.echo.kind, seg: e.customData.echo.seg })))`
let shot = 0
let lastCount = -1
for (let t = 0; t < seconds; t += 2) {
  await sleep(2000)
  const els = await mainEval(sceneJs).catch(() => [])
  const sig = els.map((e) => e.id).sort().join('|')
  if (sig !== String(lastCount)) {
    lastCount = sig
    shot++
    const png = (await lesson.send('Page.captureScreenshot', { format: 'png' })).result.data
    fs.writeFileSync(path.join(shots, `live-${String(shot).padStart(2, '0')}.png`), Buffer.from(png, 'base64'))
    console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)}s board now has ${els.length} lesson shapes -> live-${String(shot).padStart(2, '0')}.png`)
  }
}
const states = (await pet.eval('window.__ev')).filter(([, e]) => e.type === 'state').map(([, e]) => e.snapshot.state)
console.log('states:', states.join(','))
const entries = (await pet.eval('window.__ev')).filter(([, e]) => e.type === 'entry' && e.entry.role === 'assistant').map(([, e]) => e.entry).slice(-1)[0]
console.log('ECHO said:', JSON.stringify(entries?.text))
const statuses = (await pet.eval('window.__ev')).filter(([, e]) => e.type === 'lesson-status').map(([, e]) => e.status)
console.log('lesson statuses:', JSON.stringify(statuses))
console.log('--- [lesson] / [voice] log ---')
console.log(out.join('').split('\n').filter((l) => /\[lesson\]|\[voice\]/.test(l)).join('\n'))
const scene = await mainEval(`__echoBoard.getScene().then((s) => JSON.stringify(s.elements.filter((e) => e.customData && e.customData.echo).map((e) => ({ id: e.id, kind: e.customData.echo.kind, text: e.text })).filter((e) => e.kind === 'node' || e.kind === 'title').map((e) => e.id + (e.text ? ':' + String(e.text).replace(/\\n/g, ' / ') : ''))))`)
console.log('lesson nodes/titles on board:', scene)
pet.close()
lesson.close()
child.kill()
spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
