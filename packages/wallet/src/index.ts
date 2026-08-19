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
  type Vault
} from './vault.js'

export {
  REPLACE_CONFIRMATION,
  Wallet,
  WalletError,
  memoryVaultStore,
  type CreatedWallet,
  type RemoveOptions,
  type ReplaceOptions,
  type ReplacementStatus,
  type VaultStore,
  type WalletStatus
} from './wallet.js'
