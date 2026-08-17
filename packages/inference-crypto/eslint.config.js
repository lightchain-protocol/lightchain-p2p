import config from '@lcai-p2p/eslint-config'

export default [
  ...config,
  {
    // Runs under both Bare and Node, so it sees the union of their globals.
    // `Bare` exists in neither lint environment and is guarded at runtime.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Bare: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly'
      }
    }
  }
]
