export { KeystoreError, addressOf, decrypt, encrypt, type KeystoreV3 } from './keystore.js'

export { DerivedKeyError, deriveKey, openData, openJson, sealData, sealJson } from './derived.js'

export {
  SealedStore,
  SealedStoreError,
  memoryByteStore,
  type ByteStore,
  type SealedStoreOptions
} from './sealed-store.js'

export {
  ACCOUNT_PATH,
  MAX_ACCOUNT_INDEX,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  VaultError,
  derivePrivateKey,
  generatePhrase,
  isAccountIndex,
  isValidPhrase,
  normalise,
  open,
  seal,
  type Secret,
  type Vault
} from './vault.js'

export {
  AUTO_LOCK_OFF,
  DEFAULT_AUTO_LOCK_MS,
  REPLACE_CONFIRMATION,
  Wallet,
  WalletError,
  memoryVaultStore,
  type CreatedWallet,
  type ImportOptions,
  type RemoveOptions,
  type ReplaceOptions,
  type ReplacementStatus,
  type VaultStore,
  type WalletOptions,
  type WalletStatus
} from './wallet.js'
