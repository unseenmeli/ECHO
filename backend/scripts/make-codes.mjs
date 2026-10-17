// Prints new judge access codes and the ECHO_ACCESS_CODES line to paste into Vercel.
//   npm run codes -- 5            five codes labelled judge-1 … judge-5
//   npm run codes -- alice bob    one code each for these labels
import { randomInt } from 'node:crypto'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
const code = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')).join('-')

const args = process.argv.slice(2)
const labels = args.length === 1 && /^\d+$/.test(args[0])
  ? Array.from({ length: Number(args[0]) }, (_, i) => `judge-${i + 1}`)
  : args.length ? args : ['judge-1']

const pairs = labels.map((label) => [label, code()])
for (const [label, c] of pairs) console.log(`${label.padEnd(12)} ${c}`)
console.log(`\nECHO_ACCESS_CODES=${pairs.map(([l, c]) => `${l}:${c}`).join(',')}`)
