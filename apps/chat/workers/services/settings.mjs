/**
 * Settings, and the two things derived from them.
 *
 * This was four functions and a mutable binding spread across a hundred lines of
 * boot. The network in particular was kept in a second variable that
 * `saveSettings` had to remember to recompute — so a write that forgot left the
 * process talking to whichever chain it started on. It is derived on read now,
 * which removes the chance to forget rather than documenting it.
 */

import path from 'bare-path'
import fs from 'bare-fs'
import process from 'bare-process'
import { DEFAULT_AUTO_LOCK_MS } from '@lcai-p2p/wallet'
import { networkName } from '../handlers/settings.mjs'

/**
 * The idle timeout, read before the wallet exists so it applies from the first
 * unlock rather than from whenever a settings handler first runs.
 *
 * Stored in minutes because that is the unit anybody choosing it thinks in.
 * Zero switches it off, which is a choice somebody is allowed to make on a
 * machine only they use.
 */
function autoLockMsFromSettings(values) {
  const raw = values.autoLockMinutes
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return DEFAULT_AUTO_LOCK_MS
  return Number(raw) * 60 * 1000
}

export function createSettings({ chatDir }) {
  /**
   * Settings, in one file rather than scattered across sections.
   *
   * Layered over the environment: a value set here wins, and anything unset falls
   * back to the variables the worker toolkit already uses, so an operator's
   * existing shell setup keeps working and the CLI and the app agree.
   */
  const settingsFile = path.join(chatDir, 'settings.json')

  function readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeSettings(next) {
    fs.mkdirSync(chatDir, { recursive: true })
    // Not world-readable: an old file may still hold a plaintext keystore
    // password until the next unlock migrates it into the sealed store.
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
  }

  let settings = readSettings()

  /** A setting, then the environment, then nothing. */
  function setting(key, envName) {
    const value = settings[key]
    if (typeof value === 'string' && value !== '') return value
    const fromEnv = process.env[envName]
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
  }

  /**
   * The network these settings name.
   *
   * Derived on every read rather than held. See the note at the top of this
   * file: the held copy is what used to go stale.
   */
  const network = () => networkName(setting('network', 'NETWORK'))

  /** Records the settings and adopts them in the same breath. */
  function save(next) {
    writeSettings(next)
    settings = next
  }

  return {
    values: () => settings,
    save,
    setting,
    network,
    autoLockMs: () => autoLockMsFromSettings(settings)
  }
}
