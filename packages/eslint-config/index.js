import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Shared flat config.
 *
 * The one project-specific rule is the import boundary: applications compose
 * packages and must never import Pear modules directly. That keeps native
 * addons out of the Electron renderer and stops the two engineering tracks
 * from reaching into each other's territory.
 */
export const pearBoundary = {
  files: ['apps/**/*.{ts,tsx,js,mjs}'],
  ignores: ['apps/**/workers/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              'hypercore',
              'hyperdrive',
              'hyperblobs',
              'hyperswarm',
              'hyperdht',
              'autobase',
              'autopass',
              'corestore',
              'hyperbee',
              'blind-peering',
              'blind-pairing',
              'sodium-native'
            ],
            message:
              'Apps must not import Pear modules directly. Use a package under packages/ instead — see CONTRIBUTING.md.'
          }
        ]
      }
    ]
  }
}

/**
 * Scripts under `scripts/` run under Bare as well as Node — the cross-runtime
 * checks that exist precisely because the two runtimes differ. They see the
 * union of both sets of globals, and `Bare` belongs to neither lint
 * environment.
 */
export const bareScripts = {
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

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/.turbo/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  pearBoundary,
  bareScripts
)
