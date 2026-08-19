import config from '@lcai-p2p/eslint-config'

// `.mjs` rather than `.js`, because this package has no `"type": "module"` and
// Electron's main process needs to stay CommonJS.
export default config
