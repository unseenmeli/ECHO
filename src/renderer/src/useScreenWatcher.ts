import { useCallback, useEffect, useRef, useState } from 'react'
import type { FrameTrigger, SharingState } from '../../shared/screen'

const SAMPLE_INTERVAL_MS = 2000
// Claude's sweet spot for image input; larger frames are downscaled anyway.
const MAX_EDGE = 1568
const JPEG_QUALITY = 0.8
// Interval frames are skipped unless the screen visibly changed: mean absolute
// luminance difference (0–255) between 16×16 thumbnails.
const SIGNATURE_SIZE = 16
const CHANGE_THRESHOLD = 2

function signature(source: OffscreenCanvas): Uint8Array {
  const thumb = new OffscreenCanvas(SIGNATURE_SIZE, SIGNATURE_SIZE)
  const ctx = thumb.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE)
  const { data } = ctx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE)
  const lum = new Uint8Array(SIGNATURE_SIZE * SIGNATURE_SIZE)
  for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] * 3 + data[i * 4 + 1] * 6 + data[i * 4 + 2]) / 10
  return lum
}

function changed(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a) return true
  let diff = 0
  for (let i = 0; i < b.length; i++) diff += Math.abs(a[i] - b[i])
  return diff / b.length >= CHANGE_THRESHOLD
}

// Kept in the viewport (1px, transparent) so Chromium never pauses it as an
// offscreen video.
function createVideoSink(): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  Object.assign(video.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none'
  })
  document.body.appendChild(video)
  return video
}

/**
 * Owns the screen-share stream for the companion. Sampling and storage
 * policy live in the main process; this hook only captures and reports.
 */
export function useScreenWatcher() {
  const [state, setState] = useState<SharingState>({ status: 'off', sourceLabel: null })
  const statusRef = useRef(state.status)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastSignature = useRef<Uint8Array | null>(null)

  const stop = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    streamRef.current = null
    stream.getTracks().forEach((t) => t.stop())
    if (videoRef.current) videoRef.current.srcObject = null
    lastSignature.current = null
    window.companion.screen.reportStopped()
  }, [])

  const start = useCallback(async () => {
    if (streamRef.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false })
    } catch {
      return // Picker cancelled or permission denied.
    }
    const [track] = stream.getVideoTracks()
    // Fires when sharing is stopped from the OS (e.g. the macOS menu-bar indicator).
    track.addEventListener('ended', stop)
    streamRef.current = stream
    videoRef.current ??= createVideoSink()
    videoRef.current.srcObject = stream
    await videoRef.current.play()
    window.companion.screen.reportStarted(track.label)
  }, [stop])

  const capture = useCallback(async (trigger: FrameTrigger, requestId: string | null = null) => {
    const video = videoRef.current
    if (!streamRef.current || !video?.videoWidth) throw new Error('No video frame available yet')

    const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.round(video.videoWidth * scale)
    const height = Math.round(video.videoHeight * scale)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(video, 0, 0, width, height)

    const sig = signature(canvas)
    if (trigger === 'interval' && !changed(lastSignature.current, sig)) return
    lastSignature.current = sig

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    window.companion.screen.sendFrame({
      requestId,
      trigger,
      capturedAt: Date.now(),
      width,
      height,
      mimeType: 'image/jpeg',
      bytes: new Uint8Array(await blob.arrayBuffer())
    })
  }, [])

  // Status is authoritative in the main process (it owns pause).
  useEffect(
    () =>
      window.companion.screen.onStatus((s) => {
        statusRef.current = s.status
        setState(s)
      }),
    []
  )

  useEffect(() => {
    const timer = setInterval(() => {
      if (statusRef.current === 'sharing') capture('interval').catch(() => {})
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [capture])

  useEffect(() => {
    const offGrab = window.companion.screen.onGrabRequest((requestId) => {
      capture('fresh', requestId).catch((err: unknown) =>
        window.companion.screen.reportGrabFailed(requestId, err instanceof Error ? err.message : String(err))
      )
    })
    const offStop = window.companion.screen.onStopRequest(stop)
    // The main process (tray menu) starts sharing by dispatching this event
    // with a user gesture, which getDisplayMedia requires.
    const onStartRequest = (): void => void start()
    window.addEventListener('echo:start-sharing', onStartRequest)
    return () => {
      offGrab()
      offStop()
      window.removeEventListener('echo:start-sharing', onStartRequest)
    }
  }, [capture, start, stop])

  // Release the capture if the window goes away (e.g. reload in dev).
  useEffect(() => stop, [stop])

  return {
    ...state,
    start,
    togglePause: window.companion.screen.togglePause
  }
}
