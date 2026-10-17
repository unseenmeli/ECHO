import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Third-party runtime assets that libraries fetch by URL rather than import.
// Serving them from the app (dev server and build output) keeps everything
// working offline instead of depending on a CDN.
const nm = (p: string): string => resolve(__dirname, 'node_modules', p)

const STATIC_DIRS: Record<string, string> = {
  // Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH.
  'excalidraw-assets/fonts/': nm('@excalidraw/excalidraw/dist/prod/fonts')
}

const STATIC_FILES: Record<string, string> = {
  // Silero voice-activity detection (@ricky0123/vad-web) and its onnxruntime WASM runtime.
  'vad-assets/vad.worklet.bundle.min.js': nm('@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'),
  'vad-assets/silero_vad_v5.onnx': nm('@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
  'vad-assets/ort-wasm-simd-threaded.mjs': nm('onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'),
  'vad-assets/ort-wasm-simd-threaded.wasm': nm('onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'),
  // Pyodide (CPython compiled to WebAssembly), for the Run button on Python code cards.
  ...Object.fromEntries(
    ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'].map((f) => [
      `pyodide/${f}`,
      nm(`pyodide/${f}`)
    ])
  )
}

const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.onnx': 'application/octet-stream',
  '.zip': 'application/zip',
  '.json': 'application/json'
}

function resolveAsset(urlPath: string): string | null {
  const rel = urlPath.replace(/^\/+/, '')
  if (STATIC_FILES[rel]) return STATIC_FILES[rel]
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!rel.startsWith(prefix)) continue
    const file = resolve(dir, rel.slice(prefix.length))
    if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) return file
  }
  return null
}

function staticAssets(): Plugin {
  let outDir = ''
  return {
    name: 'static-runtime-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = resolveAsset(decodeURIComponent((req.url ?? '').split('?')[0]))
        if (!file) return next()
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    async closeBundle() {
      if (!outDir) return
      for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
        await cp(dir, resolve(outDir, prefix), { recursive: true })
      }
      for (const [rel, file] of Object.entries(STATIC_FILES)) {
        const dest = resolve(outDir, rel)
        await mkdir(dirname(dest), { recursive: true })
        await cp(file, dest)
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          tutor: resolve(__dirname, 'src/preload/tutor.ts'),
          voiceEngine: resolve(__dirname, 'src/preload/voiceEngine.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), staticAssets()],
    build: {
      rollupOptions: {
        input: {
          companion: resolve(__dirname, 'src/renderer/index.html'),
          tutor: resolve(__dirname, 'src/renderer/tutor.html'),
          voiceEngine: resolve(__dirname, 'src/renderer/voice-engine.html')
        }
      }
    }
  }
})
