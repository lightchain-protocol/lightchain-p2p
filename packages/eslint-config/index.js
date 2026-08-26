import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * Shared flat config.
 *
 * The one project-specific rule is the import boundary: applications compose
 * packages and must never import Pear modules directly. That keeps native
 * addons out of the Electron renderer and stops the two engineering tracks
 * from reaching into each other's territory.
 */
export const pearBoundary = {
  // Relative to the config that spreads this in, which is each app's own
  // `eslint.config.mjs`, run by Turbo with that app as the working directory.
  // These patterns used to read `apps/**`, and inside `apps/chat` there is no
  // `apps/` to match — so the rule was configured, exported, composed, and
  // matched not one file in the repository. `eslint --print-config` on a
  // renderer module reported `no-restricted-imports: undefined`. Verify a
  // change here the same way: a green lint run is what the defect produces.
  files: ['**/*.{ts,tsx,js,mjs}'],
  // Workers are the documented exception — they are the data plane, and the
  // stack is what they are for. `scripts/` is the undocumented one: the wsl-*
  // harnesses drive a second peer from Node and legitimately build their own
  // Corestore and swarm, which is the whole point of testing against a
  // separate implementation.
  ignores: ['workers/**', 'scripts/**'],
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
      process: 'readonly',
      // Present in both Node and Bare, the latter once the runtime polyfills
      // are imported — which the scripts that use them do.
      AbortSignal: 'readonly',
      TextDecoder: 'readonly',
      TextEncoder: 'readonly',
      URL: 'readonly',
      WebSocket: 'readonly',
      clearInterval: 'readonly',
      clearTimeout: 'readonly',
      fetch: 'readonly',
      performance: 'readonly',
      setInterval: 'readonly',
      setTimeout: 'readonly'
    }
  }
}

/**
 * Runtime adapters: the small per-runtime files behind a `#` import.
 *
 * They exist precisely to touch globals that only one runtime has, so the
 * globals list here is the union rather than what any single runtime provides.
 */
export const runtimeAdapters = {
  files: ['runtime/**/*.js'],
  languageOptions: {
    globals: {
      Buffer: 'readonly',
      TextDecoder: 'readonly',
      TextEncoder: 'readonly',
      WebSocket: 'readonly',
      console: 'readonly',
      globalThis: 'readonly',
      process: 'readonly'
    }
  }
}

/**
 * The three runtimes an Electron application is written in at once.
 *
 * Without these the apps cannot be linted at all: the shared config assumes
 * Node, so a first run over `apps/chat` reports 465 `no-undef` for `document`,
 * `Bare` and `console` — globals that genuinely exist where they are used — and
 * the three real findings underneath are unreadable. That is why no application
 * had ever been linted, and why a duplicate declaration once shipped past both
 * `pnpm build` and `pnpm lint` into a renderer that could not load a module.
 */
export const electronMain = {
  // `forge.config.js` sits beside them and is the same thing: Node, CommonJS,
  // never bundled and never shipped to a renderer.
  files: ['electron/**/*.js', 'forge.config.js'],
  languageOptions: {
    sourceType: 'commonjs',
    globals: { ...globals.node }
  },
  rules: {
    // The main process is CommonJS by necessity: Electron's own entry point is
    // required rather than imported.
    '@typescript-eslint/no-require-imports': 'off'
  }
}

export const electronRenderer = {
  files: ['renderer/**/*.js'],
  languageOptions: {
    sourceType: 'module',
    globals: { ...globals.browser }
  }
}

/** Bare, which is neither Node nor a browser and shares globals with both. */
const bareGlobals = {
  Bare: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  WebSocket: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  fetch: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly'
}

/**
 * Bare in CommonJS, which the supervisor's entry and its worker still are.
 *
 * Bare supports `require`, so this is a real shape rather than a leftover, and
 * the rule against it is about TypeScript packages rather than these.
 */
export const bareCommonJs = {
  files: ['app.js', 'workers/**/*.js'],
  languageOptions: {
    sourceType: 'commonjs',
    globals: bareGlobals
  },
  rules: {
    '@typescript-eslint/no-require-imports': 'off'
  }
}

/** Tests run under vitest, which is Node. */
export const appTests = {
  files: ['test/**/*.{js,mjs}'],
  languageOptions: {
    sourceType: 'module',
    globals: { ...globals.node }
  }
}

export const bareWorkers = {
  files: ['workers/**/*.mjs', 'lib/**/*.mjs', 'bin.mjs'],
  languageOptions: {
    sourceType: 'module',
    globals: {
      Bare: 'readonly',
      Buffer: 'readonly',
      console: 'readonly',
      global: 'readonly',
      globalThis: 'readonly',
      process: 'readonly',
      queueMicrotask: 'readonly',
      structuredClone: 'readonly',
      AbortController: 'readonly',
      AbortSignal: 'readonly',
      TextDecoder: 'readonly',
      TextEncoder: 'readonly',
      URL: 'readonly',
      WebSocket: 'readonly',
      clearInterval: 'readonly',
      clearTimeout: 'readonly',
      fetch: 'readonly',
      setInterval: 'readonly',
      setTimeout: 'readonly'
    }
  }
}

/**
 * The rules that need a type checker.
 *
 * `tseslint.configs.recommended` is a syntax-only pass: it never asks what a
 * value is, so the mistakes it cannot see are the ones that matter here — a
 * promise nobody awaited, a condition that is always true, an `any` flowing out
 * of an untyped module and into a signing call. This project moves money on the
 * back of async chain reads, so `no-floating-promises` alone earns the cost.
 *
 * Scoped to TypeScript. The applications are hand-rolled ES modules with no
 * build step (see the interface contract), so there is no program for the
 * checker to ask about them; typing those is a separate job with `checkJs`.
 */
const typeChecked = tseslint.config({
  files: ['**/*.ts'],
  extends: [...tseslint.configs.recommendedTypeChecked],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: process.cwd()
    }
  },
  rules: {
    /**
     * Reported where they are not decisions.
     *
     * `require-await` fires on an async function that awaits nothing, which is
     * usually an interface being conformed to rather than a mistake — a handler
     * map whose members must all return promises, for instance. The rule cannot
     * tell those apart and there are forty-odd of them.
     */
    '@typescript-eslint/require-await': 'off'
  }
})

/**
 * One rule that has to come off in tests, because the two tools disagree there.
 *
 * `no-unnecessary-type-assertion` called three assertions in `packages/chain`
 * redundant and its fixer removed them; `tsc -p tsconfig.json` then rejected all
 * three. The assertions narrow a string to a `0x${string}` template type, and
 * whichever program the service resolves a test file against is not the one the
 * package typechecks with. A rule whose fixer breaks the build is worse than no
 * rule, and the check that matters here — `typecheck` — already covers it.
 */
const typeCheckedTests = tseslint.config({
  files: ['**/*.test.ts'],
  rules: {
    '@typescript-eslint/no-unnecessary-type-assertion': 'off'
  }
})

const shared = tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/.turbo/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  bareScripts,
  runtimeAdapters,
  electronMain,
  electronRenderer,
  bareWorkers,
  bareCommonJs,
  appTests,
  ...typeChecked,
  ...typeCheckedTests
)

export default shared

/**
 * What an application lints with: the above, plus the import boundary.
 *
 * The boundary is deliberately not in the default export. Rule 1 is that
 * *applications* compose packages — inside `packages/` the stack is the job,
 * and `packages/testkit` builds a Corestore and a swarm on purpose. Sharing one
 * config meant the rule had to be written with an `apps/**` glob to keep it off
 * the packages, and that glob is what made it match nothing anywhere. Splitting
 * the two lets each say what it means.
 */
export const appConfig = tseslint.config(...shared, pearBoundary)
