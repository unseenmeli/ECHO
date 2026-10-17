import { defineConfig } from 'vitest/config'

// `npm run eval`: the quality evaluation against the real services (see tests/eval/README.md).
export default defineConfig({
  test: {
    include: ['tests/eval/quality.eval.test.ts'],
    environment: 'node',
    env: { ECHO_EVAL: '1' },
    testTimeout: 60 * 60 * 1000
  }
})
