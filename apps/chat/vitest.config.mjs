import base from '@lcai-p2p/vitest-config/base.js'

// Most of this app is only testable by driving a real Electron window, which is
// what scripts/*.mjs do. What sits here is the small amount that is pure enough
// to check without one — and worth checking, because the alternative is a rule
// reachable only behind a native dialog.
export default {
  ...base,
  test: { ...base.test, include: ['test/**/*.test.js'] }
}
