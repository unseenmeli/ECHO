// Dev only: `npm run dev` runs the stock electron.exe, which Task Manager shows with the Electron logo and name.
// This stamps the app's logo (resources/icon.png) and name into that exe. Packaged builds (electron-builder) already
// carry the logo, and `npm install` restores the stock exe, so this runs before every `dev`. Windows only.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

if (process.platform !== 'win32') process.exit(0)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { rcedit } = require('rcedit')
const exe = process.argv[2] ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

// An .ico file may hold a PNG as-is (256 px is written as 0): wrap resources/icon.png in the ICO header.
const png = readFileSync(join(root, 'resources', 'icon.png'))
const width = png.readUInt32BE(16)
const height = png.readUInt32BE(20)
const header = Buffer.alloc(22)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // one image
header.writeUInt8(width >= 256 ? 0 : width, 6)
header.writeUInt8(height >= 256 ? 0 : height, 7)
header.writeUInt16LE(1, 10) // colour planes
header.writeUInt16LE(32, 12) // bits per pixel
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(22, 18)
const ico = join(mkdtempSync(join(tmpdir(), 'echo-icon-')), 'icon.ico')
writeFileSync(ico, Buffer.concat([header, png]))

try {
  await rcedit(exe, {
    icon: ico,
    'version-string': { ProductName: 'Echo', FileDescription: 'Echo', InternalName: 'Echo', OriginalFilename: 'Echo.exe' }
  })
  console.log('dev-icon: electron.exe now shows the Echo logo and name')
} catch (err) {
  // Usually the exe is in use by a running dev session: close it and run again.
  console.warn(`dev-icon: skipped (${err instanceof Error ? err.message.split('\n')[0] : err})`)
}
