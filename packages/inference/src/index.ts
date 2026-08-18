export {
  Api,
  ApiError,
  type ApiOptions,
  type Balance,
  type Draw,
  type Flavour,
  type Model,
  type Prepared,
  type Session
} from './api.js'

export { KeyEncodingError, decodeKey, encodeSealed } from './keys.js'

export { History, type Log, type Record, type Transcript, type Turn } from './history.js'

export {
  Conversation,
  ConversationError,
  type Answer,
  type ConversationOptions,
  type Progress
} from './conversation.js'

export {
  SignatureError,
  checkCommitment,
  recoverFrameSigner,
  responseDigest,
  verifyFrame,
  type Commitment,
  type FrameToVerify
} from './verify.js'

export {
  AnswerError,
  isAnswerVerified,
  verifyRoomAnswer,
  type AnswerChecks
} from './room-answer.js'
