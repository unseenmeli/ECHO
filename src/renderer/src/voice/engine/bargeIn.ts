/**
 * Decides when speech picked up by the local VAD while ECHO is talking is
 * sustained enough to count as the user interrupting.
 *
 * A single "speech started" blip would make ECHO stop for every cough, click
 * or bit of leaked playback. Instead this accumulates speech time over a
 * sliding window, so brief sounds are ignored while a real "wait, stop..."
 * (even with small gaps between words) is caught after roughly `needMs`.
 */
export interface BargeInOptions {
  /** Speech probability above which a frame counts as speech. */
  threshold: number
  /** Length of one VAD frame in ms (512 samples at 16 kHz = 32 ms). */
  frameMs: number
  /** Sliding window length. */
  windowMs: number
  /** Speech needed inside the window to trigger. */
  needMs: number
}

export const DEFAULT_BARGE_IN: Omit<BargeInOptions, 'needMs'> = {
  threshold: 0.6,
  frameMs: 32,
  windowMs: 1300
}

export class BargeInDetector {
  private speechFrames: number[] = [] // timestamps (ms) of frames that were speech

  constructor(private readonly opts: BargeInOptions) {}

  /** Feed one VAD frame. Returns true once, when the interruption threshold is reached. */
  feed(speechProbability: number, nowMs: number): boolean {
    if (this.opts.needMs <= 0) return false
    const { threshold, frameMs, windowMs, needMs } = this.opts
    if (speechProbability >= threshold) this.speechFrames.push(nowMs)
    const cutoff = nowMs - windowMs
    while (this.speechFrames.length && this.speechFrames[0] < cutoff) this.speechFrames.shift()
    if (this.speechFrames.length * frameMs >= needMs) {
      this.speechFrames = []
      return true
    }
    return false
  }

  reset(): void {
    this.speechFrames = []
  }
}
