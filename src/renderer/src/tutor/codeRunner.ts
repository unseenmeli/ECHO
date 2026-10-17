export type RunLanguage = 'python' | 'javascript'

export interface RunRequest {
  id: number
  language: RunLanguage
  code: string
  /** Where Pyodide's files are served (see electron.vite.config.ts). */
  pyodideUrl: string
}

export type RunEvent = { id: number; type: 'started' } | { id: number; type: 'done'; output: string; error: string | null }

export interface RunResult {
  output: string
  error: string | null
}

/** How long the code itself may run (Python's first load is not counted). */
const RUN_TIMEOUT_MS = 8000
const PYODIDE_URL = new URL('./pyodide/', location.href).href

/**
 * Runs code cards in a worker. One run at a time; the worker (and Pyodide in it) is kept warm between runs and
 * replaced if a run has to be killed.
 */
export function createCodeRunner() {
  let worker: Worker | null = null
  let nextId = 1
  let queue: Promise<unknown> = Promise.resolve()

  const spawn = (): Worker => (worker ??= new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module' }))
  const kill = (): void => {
    worker?.terminate()
    worker = null
  }

  const runOnce = (language: RunLanguage, code: string): Promise<RunResult> =>
    new Promise((resolve) => {
      const w = spawn()
      const id = nextId++
      let timer = 0
      const finish = (r: RunResult): void => {
        window.clearTimeout(timer)
        w.removeEventListener('message', onMessage)
        w.removeEventListener('error', onError)
        resolve(r)
      }
      const onMessage = (e: MessageEvent<RunEvent>): void => {
        if (e.data.id !== id) return
        if (e.data.type === 'started') {
          timer = window.setTimeout(() => {
            kill()
            finish({ output: '', error: `Stopped after ${RUN_TIMEOUT_MS / 1000} seconds (is there an endless loop?)` })
          }, RUN_TIMEOUT_MS)
        } else finish({ output: e.data.output, error: e.data.error })
      }
      const onError = (e: ErrorEvent): void => {
        kill()
        finish({ output: '', error: e.message || 'The code runner failed to start' })
      }
      w.addEventListener('message', onMessage)
      w.addEventListener('error', onError)
      w.postMessage({ id, language, code, pyodideUrl: PYODIDE_URL } satisfies RunRequest)
    })

  return {
    run(language: RunLanguage, code: string): Promise<RunResult> {
      const result = queue.then(() => runOnce(language, code))
      queue = result.catch(() => {})
      return result
    },
    dispose: kill
  }
}
