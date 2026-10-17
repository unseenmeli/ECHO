import { useEffect, useState } from 'react'
import frame1 from './assets/poses/frame-1.png'
import frame2 from './assets/poses/frame-2.png'
import frame3 from './assets/poses/frame-3.png'

// First frame is the resting stance. The loop ping-pongs (1 → 2 → 3 → 2 → 1)
// so it eases back instead of snapping from the last frame to the first;
// frames crossfade in CSS (.sprite img transition).
const FRAMES = [frame1, frame2, frame3]
const SEQUENCE = [0, 1, 2, 1]
const IDLE_HOLD_MS = 6000
const FRAME_MS = 280

function useFrameIndex(): number {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const delay = step === 0 ? IDLE_HOLD_MS : FRAME_MS
    const timer = setTimeout(() => setStep((step + 1) % SEQUENCE.length), delay)
    return () => clearTimeout(timer)
  }, [step])

  return SEQUENCE[step]
}

export function CharacterSprite() {
  const index = useFrameIndex()

  // All frames stay mounted so swapping never flashes while decoding.
  return (
    <div className="sprite">
      {FRAMES.map((src, i) => (
        <img key={i} src={src} alt="" draggable={false} className={i === index ? 'is-active' : undefined} />
      ))}
    </div>
  )
}
