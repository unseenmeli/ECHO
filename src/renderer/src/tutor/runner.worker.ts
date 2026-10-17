/// <reference lib="webworker" />
import type { PyodideInterface } from 'pyodide'
import type { RunEvent, RunRequest } from './codeRunner'

// Runs a code card's source off the main thread. The worker has no DOM, no Node and no IPC; the page kills it
// if a run takes too long (an infinite loop can't be interrupted any other way).

const MAX_OUTPUT = 20_000
let pyodide: Promise<PyodideInterface> | null = null

const post = (e: RunEvent): void => self.postMessage(e)

function collector() {
  let text = ''
  return {
    write(s: string): void {
      if (text.length < MAX_OUTPUT) text += s
    },
    get text(): string {
      return text.slice(0, MAX_OUTPUT)
    }
  }
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

async function runJavaScript(req: RunRequest, out: ReturnType<typeof collector>): Promise<void> {
  const log = (...args: unknown[]): void => out.write(args.map(show).join(' ') + '\n')
  const sandboxConsole = { log, info: log, warn: log, error: log, debug: log }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = new AsyncFunction('console', req.code)
  post({ id: req.id, type: 'started' })
  try {
    await fn(sandboxConsole)
  } catch (err) {
    throw new Error(show(err))
  }
}

/** Pyodide's traceback starts inside its own runtime; keep the learner's line and the exception itself. */
function pythonError(message: string): string {
  const lines = message.trim().split('\n')
  const last = lines.at(-1)?.trim() ?? 'Error'
  const at = [...lines].reverse().find((l) => l.includes('File "main.py"'))?.match(/line (\d+)/)
  return at ? `Line ${at[1]}: ${last}` : last
}

async function runPython(req: RunRequest, out: ReturnType<typeof collector>): Promise<void> {
  pyodide ??= import(/* @vite-ignore */ `${req.pyodideUrl}pyodide.mjs`).then(
    (m: typeof import('pyodide')) => m.loadPyodide({ indexURL: req.pyodideUrl })
  )
  const py = await pyodide
  py.setStdout({ batched: (s) => out.write(s + '\n') })
  py.setStderr({ batched: (s) => out.write(s + '\n') })
  py.setStdin({ error: true })
  // A fresh namespace per run, so one run's variables don't leak into the next.
  const globals = py.globals.get('dict')()
  post({ id: req.id, type: 'started' })
  try {
    await py.runPythonAsync(req.code, { globals, filename: 'main.py' })
  } catch (err) {
    throw new Error(pythonError(err instanceof Error ? err.message : String(err)))
  } finally {
    globals.destroy()
  }
}

self.onmessage = async (e: MessageEvent<RunRequest>): Promise<void> => {
  const req = e.data
  const out = collector()
  try {
    await (req.language === 'python' ? runPython(req, out) : runJavaScript(req, out))
    post({ id: req.id, type: 'done', output: out.text, error: null })
  } catch (err) {
    post({ id: req.id, type: 'done', output: out.text, error: err instanceof Error ? err.message : show(err) })
  }
}
