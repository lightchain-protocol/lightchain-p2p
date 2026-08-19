import base from '@lcai-p2p/vitest-config/base.js'

// This app is Bare rather than TypeScript, so its tests sit in test/ as .js
// next to the .mjs they cover, and the shared include of src/**/*.test.ts finds
// nothing here.
//
// The bare-* modules have no Node build: bare-fs and bare-path fail on a
// missing `Bare` global, bare-os and bare-process on `require.addon`. The first
// two are aliased to the Node built-ins they mirror, which is sound for the
// calls used here — readFileSync, writeFileSync, mkdirSync, chmodSync, join.
// The other two cannot be aliased that way, so a module importing them stays
// out of reach of this runner; that is why the logic under test lives apart
// from worker.mjs.
export default {
  ...base,
  resolve: {
    ...base.resolve,
    alias: { ...base.resolve?.alias, 'bare-fs': 'node:fs', 'bare-path': 'node:path' }
  },
  test: { ...base.test, include: ['test/**/*.test.js'] }
}
