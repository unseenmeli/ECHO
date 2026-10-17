import { contextBridge, ipcRenderer } from 'electron'
import type { EngineError, EnginePlaybackReport, EngineStartOptions } from '../shared/voice'

type Unsubscribe = () => void

// Only the hidden audio-engine window gets this. It carries audio and engine
// status; no credentials ever reach a renderer.
const on = <A extends unknown[]>(channel: string, cb: (...args: A) => void): Unsubscribe => {
  const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ready: (): void => ipcRenderer.send('voice-engine:ready'),
  error: (err: EngineError): void => ipcRenderer.send('voice-engine:error', err),
  /** 16 kHz mono PCM16 from the microphone, 80 ms per frame. */
  mic: (pcm: ArrayBuffer): void => ipcRenderer.send('voice-engine:mic', new Uint8Array(pcm)),
  vad: (speaking: boolean): void => ipcRenderer.send('voice-engine:vad', speaking),
  /** Sustained speech heard while ECHO is talking. */
  bargeIn: (): void => ipcRenderer.send('voice-engine:barge'),
  playback: (report: EnginePlaybackReport): void => ipcRenderer.send('voice-engine:playback', report),

  onStart: (cb: (opts: EngineStartOptions) => void): Unsubscribe => on('voice-engine:start', cb),
  onStop: (cb: () => void): Unsubscribe => on('voice-engine:stop', cb),
  onMute: (cb: (muted: boolean) => void): Unsubscribe => on('voice-engine:mute', cb),
  /** 24 kHz mono PCM16 to play, tagged with the response it belongs to. */
  onAudio: (cb: (responseId: string, pcm: Uint8Array) => void): Unsubscribe => on('voice-engine:audio', cb),
  onMarker: (cb: (responseId: string, segment: number) => void): Unsubscribe => on('voice-engine:marker', cb),
  onDone: (cb: (responseId: string) => void): Unsubscribe => on('voice-engine:done', cb),
  onClear: (cb: (responseId: string) => void): Unsubscribe => on('voice-engine:clear', cb),
  onDuck: (cb: (on: boolean) => void): Unsubscribe => on('voice-engine:duck', cb)
}

contextBridge.exposeInMainWorld('voiceEngine', api)

export type VoiceEngineApi = typeof api
