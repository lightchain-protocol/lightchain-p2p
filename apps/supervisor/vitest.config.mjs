import base from '@lcai-p2p/vitest-config/base.js'

// This app is Bare rather than TypeScript, so its tests sit in test/ as .js
// next to the .mjs they cover, and the shared include of src/**/*.test.ts finds
// nothing here.
export default {
  ...base,
  test: { ...base.test, include: ['test/**/*.test.js'] }
}
