export { KeystoreError, addressOf, decrypt, encrypt, type KeystoreV3 } from './keystore.js'

export { DerivedKeyError, deriveKey, openData, openJson, sealData, sealJson } from './derived.js'

export {
  ACCOUNT_PATH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  VaultError,
  derivePrivateKey,
  generatePhrase,
  isValidPhrase,
  normalise,
  open,
  seal,
  type Vault
} from './vault.js'

export {
  Wallet,
  WalletError,
  memoryVaultStore,
  type CreatedWallet,
  type VaultStore,
  type WalletStatus
} from './wallet.js'
