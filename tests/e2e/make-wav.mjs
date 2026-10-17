// Builds a fake-microphone clip: lead silence + the spoken question + long silence,
// so the (looping) fake capture device produces exactly one utterance per ~45 s.
// Usage: node make-wav.mjs <speech.wav (16 kHz mono PCM16)> <out.wav>
import fs from 'node:fs'

const [, , input, output, repeatArg] = process.argv
const repeat = Number(repeatArg || 0)
const wav = fs.readFileSync(input)
const dataAt = wav.indexOf('data') + 8
const speech = wav.subarray(dataAt)
const rate = 16000
const silence = (seconds) => Buffer.alloc(Math.round(rate * seconds) * 2)
// repeat > 0: the utterance recurs every few seconds (used to trigger voice-activity detection while ECHO talks).
const pcm = repeat > 0 ? Buffer.concat(Array.from({ length: repeat }, () => Buffer.concat([silence(1), speech, silence(3)]))) : Buffer.concat([silence(2), speech, silence(40)])

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
fs.writeFileSync(output, Buffer.concat([header, pcm]))
console.log(`wrote ${output}: ${(pcm.length / 2 / rate).toFixed(1)} s`)
