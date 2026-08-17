import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Fails if any source file carries a UTF-8 byte-order mark.
 *
 * Node tolerates a BOM in JSON; Bare does not, and reports it as
 * `Unexpected token '﻿'` against a file that looks perfectly fine in an editor.
 * PowerShell's `Set-Content -Encoding utf8` writes one by default, so this is
 * easy to reintroduce on Windows and expensive to diagnose.
 */

const BOM = '\uFEFF'
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.turbo', 'coverage'])
const EXT = /\.(json|js|mjs|cjs|ts|tsx|md|yaml|yml)$/

const offenders = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!EXT.test(entry.name) || statSync(full).size === 0) continue
    if (readFileSync(full, 'utf8').startsWith(BOM)) offenders.push(full)
  }
}

walk('.')

if (offenders.length > 0) {
  console.error('Byte-order marks found. Bare cannot parse these:\n')
  for (const f of offenders) console.error(`  ${f}`)
  console.error(
    '\nRe-save as UTF-8 without BOM. On PowerShell, prefer Out-File -Encoding utf8NoBOM.'
  )
  process.exit(1)
}

console.log('no byte-order marks')
