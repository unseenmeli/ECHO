import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

// Real pictures for the whiteboard. The tutor never writes image data or (usually) URLs: it names what to show, and
// this looks it up on Wikimedia Commons (free, licensed for reuse, no key), downloads a board-sized rendition in the
// main process, and hands it over with its credit. A direct https link (one the learner gave) also works.

export interface Picture {
  /** Stable id for the board's file store (the same picture is stored once). */
  fileId: string
  dataURL: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  width: number
  height: number
  /** What the picture actually is (the file's own title), so the tutor can be told. */
  title: string
  /** "Author · License · Wikimedia Commons", shown under the picture. */
  credit: string
  pageUrl: string
}

export interface PictureRequest {
  search?: string
  url?: string
}

export interface PictureLookup {
  find(req: PictureRequest, signal?: AbortSignal): Promise<Picture | null>
}

const API = 'https://commons.wikimedia.org/w/api.php'
/** Wikimedia asks every API client to identify itself. */
const USER_AGENT = 'ECHO-tutor/0.1 (desktop learning companion; https://github.com/unseenmeli)'
const RENDITION_WIDTH = 800
const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 6000
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
/** File types Commons renders to a bitmap thumbnail (SVG diagrams become PNG). */
const SOURCE_MIME = new Set([...MIME, 'image/svg+xml', 'image/tiff'])

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Hosts a model-chosen link may never reach: this machine and private networks. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) return false
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
  }
  if (isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:'))) return false
  return true
}

/** Pixel size from the first bytes of a PNG, GIF, WebP or JPEG. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      // Start-of-frame markers carry the size (C0-CF, except DHT C4, JPG C8 and DAC CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  return null
}

type Fetch = typeof fetch

export class CommonsPictures implements PictureLookup {
  private readonly cache = new Map<string, Promise<Picture | null>>()

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly log: (m: string) => void = (m) => console.log(m)
  ) {}

  find(req: PictureRequest, signal?: AbortSignal): Promise<Picture | null> {
    const key = req.url ? `url:${req.url}` : `search:${(req.search ?? '').trim().toLowerCase()}`
    let p = this.cache.get(key)
    if (!p) {
      p = (req.url ? this.fromUrl(req.url, signal) : this.search(req.search ?? '', signal)).catch((err: unknown) => {
        this.log(`[pictures] ${key} failed: ${err instanceof Error ? err.message : err}`)
        return null
      })
      this.cache.set(key, p)
      // Failures are not remembered: the network may be back next time.
      void p.then((r) => r || this.cache.delete(key))
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!)
    }
    return p
  }

  private async get(url: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    return this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  }

  private async search(query: string, signal?: AbortSignal): Promise<Picture | null> {
    const q = query.trim()
    if (q.length < 2) return null
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrsearch: q,
      gsrnamespace: '6',
      gsrlimit: '10',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(RENDITION_WIDTH),
      iiextmetadatafilter: 'Artist|LicenseShortName|ObjectName'
    })
    const res = await this.get(`${API}?${params}`, signal)
    if (!res.ok) throw new Error(`Commons search returned HTTP ${res.status}`)
    type Info = { mime: string; width: number; height: number; thumburl?: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }
    const body = (await res.json()) as { query?: { pages?: Array<{ index: number; title: string; imageinfo?: Info[] }> } }
    const candidates = (body.query?.pages ?? [])
      .sort((a, b) => a.index - b.index)
      .flatMap((p) => (p.imageinfo?.[0] ? [{ title: p.title, info: p.imageinfo[0] }] : []))
      // A real picture of a sensible shape and size: not an icon, a banner or a scan of a long page.
      .filter(({ info }) => SOURCE_MIME.has(info.mime) && !!info.thumburl && info.width >= 240 && info.height >= 160 && info.width / info.height < 3 && info.height / info.width < 2.2)
    for (const { title, info } of candidates.slice(0, 3)) {
      const meta = (k: string): string => stripHtml(info.extmetadata?.[k]?.value ?? '')
      const name = meta('ObjectName') || title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
      const artist = meta('Artist').slice(0, 48)
      const credit = [artist, meta('LicenseShortName'), 'Wikimedia Commons'].filter(Boolean).join(' · ')
      const picture = await this.download(info.thumburl!, signal).catch(() => null)
      if (picture) return { ...picture, title: name.slice(0, 120), credit, pageUrl: info.descriptionurl }
    }
    this.log(`[pictures] no usable picture for "${q}"`)
    return null
  }

  private async fromUrl(url: string, signal?: AbortSignal): Promise<Picture | null> {
    if (!isPublicHttpsUrl(url)) throw new Error('only public https links are fetched')
    const picture = await this.download(url, signal)
    const host = new URL(url).hostname.replace(/^www\./, '')
    return { ...picture, title: decodeURIComponent(new URL(url).pathname.split('/').pop() || host).slice(0, 120), credit: host, pageUrl: url }
  }

  private async download(url: string, signal?: AbortSignal): Promise<Omit<Picture, 'title' | 'credit' | 'pageUrl'>> {
    const res = await this.get(url, signal)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // A redirect may not lead somewhere a direct link couldn't go.
    if (res.url && !isPublicHttpsUrl(res.url)) throw new Error('redirected to a non-public address')
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!MIME.has(mime)) throw new Error(`not a picture (${mime || 'unknown type'})`)
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_BYTES) throw new Error('picture too large')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('picture too large')
    const size = imageSize(buf)
    if (!size || !size.width || !size.height) throw new Error('unreadable picture')
    return {
      fileId: createHash('sha1').update(url).digest('hex'),
      dataURL: `data:${mime};base64,${buf.toString('base64')}`,
      mimeType: mime as Picture['mimeType'],
      ...size
    }
  }
}
