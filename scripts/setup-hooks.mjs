import { execFileSync } from 'node:child_process'

/**
 * Points git at the version-controlled hooks in .githooks.
 *
 * core.hooksPath lives in .git/config, which is not cloned, so without this a
 * fresh clone silently loses the commit-msg hook and starts producing commits
 * attributed to a bot. Running it from `prepare` means it is repaired by the
 * same install every contributor already does.
 *
 * Failure is not fatal: installs from a tarball or outside a work tree have no
 * git to configure, and that should not break the install.
 */
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
} catch {
  // Not a git work tree, or git is unavailable. Nothing to configure.
}
