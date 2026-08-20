import { appConfig } from '@lcai-p2p/eslint-config'

// `.mjs` rather than `.js`, because this package has no `"type": "module"` and
// its entry and worker are CommonJS under Bare.
//
// `appConfig` rather than the default export: it adds the import boundary,
// which applies to applications and not to packages.
export default appConfig
