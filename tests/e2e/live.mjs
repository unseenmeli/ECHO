// Live check against the REAL services using the keys in .env (loaded by the app itself)
// and a fake microphone clip, so your real mic isn't used. ECHO's reply WILL play
// through your speakers. Usage: node tests/e2e/live.mjs <clip.wav> [seconds]
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wav = path.resolve(process.argv[2])
const seconds = Number(process.argv[3] || 40)
const PORT = 9555
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const child = spawn(electronPath, [root, `--remote-debugging-port=${PORT}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => out.push(String(d)))
child.stderr.on('data', (d) => out.push(String(d)))
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => ({ json: async () => [] }))).json()).filter((t) => t.type === 'page')
let comp
for (let i = 0; i < 100 && !comp; i++) { comp = (await targets()).find((t) => t.title === 'Companion'); await sleep(200) }
const ws = new WebSocket(comp.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m) }
const ev = (expression) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })) })
await ev(`window.__ev=[];window.voice.onEvent(e=>window.__ev.push([Date.now(),e]));true`)
const t0 = Date.now()
await sleep(500)
await ev(`document.querySelector('[aria-label="Start conversation"]').click();true`)
await sleep(seconds * 1000)
const r = await ev('window.__ev')
for (const [t, e] of r.result.result.value) {
  const at = ((t - t0) / 1000).toFixed(1).padStart(5)
  if (e.type === 'state') console.log(at, 'STATE', e.snapshot.state, e.snapshot.message ?? '')
  else if (e.type === 'entry' && (e.entry.final || e.entry.role === 'user')) console.log(at, 'ENTRY', e.entry.role, JSON.stringify(e.entry.text.slice(0, 90)), e.entry.final ? 'final' : '', e.entry.interrupted ? 'INTERRUPTED' : '')
  else if (e.type === 'metrics') console.log(at, 'METRICS', JSON.stringify(e.metrics))
}
console.log('--- main log ---')
console.log(out.join('').split('\n').filter((l) => l.includes('[voice]')).join('\n'))
ws.close()
child.kill()
spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' })
