import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Excalidraw loads its fonts at runtime from EXCALIDRAW_ASSET_PATH (a CDN by
// default). Serve them from the app instead so the whiteboard works offline.
const EXCALIDRAW_FONTS = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
const FONTS_URL = '/excalidraw-assets/fonts/'

function excalidrawFonts(): Plugin {
  let outDir = ''
  return {
    name: 'excalidraw-fonts',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0])
        if (!url.startsWith(FONTS_URL)) return next()
        const file = resolve(EXCALIDRAW_FONTS, url.slice(FONTS_URL.length))
        if (!file.startsWith(EXCALIDRAW_FONTS) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', 'font/woff2')
        createReadStream(file).pipe(res)
      })
    },
    async closeBundle() {
      if (outDir) await cp(EXCALIDRAW_FONTS, resolve(outDir, FONTS_URL.slice(1)), { recursive: true })
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
          tutor: resolve(__dirname, 'src/preload/tutor.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), excalidrawFonts()],
    build: {
      rollupOptions: {
        input: {
          companion: resolve(__dirname, 'src/renderer/index.html'),
          tutor: resolve(__dirname, 'src/renderer/tutor.html')
        }
      }
    }
  }
})
