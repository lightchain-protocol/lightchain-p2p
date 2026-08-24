/**
 * The worker's own key: importing one, making one, and setting its password.
 */

import { derivePrivateKey, generatePhrase } from '@lcai-p2p/wallet'

export function workerKeyHandlers(ctx, kit) {
  const { workerConfig } = ctx
  const { writeKeystore, adoptPassword, passwordFrom } = kit

  return {
    /**
     * Imports an existing private key. The key and the password it is sealed
     * with arrive in the request body; neither is logged, echoed or passed to
     * a process.
     */
    'worker.importKey': (req) => {
      const privateKey = typeof req.privateKey === 'string' ? req.privateKey.trim() : ''
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error('that does not look like a 32-byte private key (64 hex characters)')
      }
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      const address = writeKeystore(
        config,
        privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
      )
      adoptPassword(config, password)
      return { address: `0x${address}` }
    },

    /**
     * Creates a new key. The recovery phrase is returned once, for the panel to
     * show for backup, and is not stored anywhere but inside the sealed
     * keystore — lose the phrase and the password and the key is gone.
     */
    'worker.createKey': (req) => {
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      const phrase = generatePhrase()
      const address = writeKeystore(config, derivePrivateKey(phrase))
      adoptPassword(config, password)
      return { address: `0x${address}`, phrase }
    },

    /**
     * Replaces the password of the keystore already on disk — the Settings
     * page's one worker-secret action. It goes through the same proof as a
     * fresh key: the password has to open the file before it is sealed under
     * the wallet, so a typo fails here and not inside the container. The
     * settings file never sees it; `settings.write` refuses the key outright.
     */
    'worker.setPassword': (req) => {
      const password = passwordFrom(req)

      const { config, problem } = workerConfig({ keystorePassword: password })
      if (!config) throw new Error(problem ?? 'the worker is not configured')

      adoptPassword(config, password)
      return { ok: true }
    }
  }
}
