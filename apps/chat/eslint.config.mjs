import { appConfig } from '@lcai-p2p/eslint-config'

// `.mjs` rather than `.js`, because this package has no `"type": "module"` and
// Electron's main process needs to stay CommonJS.
//
// `appConfig` rather than the default export: it adds the import boundary,
// which applies to applications and not to packages.
export default appConfig
