export { Room, RoomError, type Identity, type RoomOptions, type SendOptions } from './room.js'
// Re-exported so the application has one place to read the limit from. It was
// being restated as a literal in the chat worker, because reaching into
// `@lcai-p2p/protocol` only resolved there by accident of hoisting — and two
// copies of a size cap drift, at which point a sender is refused with one
// figure and told another.
export { MAX_ATTACHMENT_SIZE } from '@lcai-p2p/protocol'
export {
  AttachmentError,
  Attachments,
  safeName,
  sniff,
  type AttachmentInput,
  type AttachmentsOptions,
  type FetchOptions,
  type SniffedType
} from './attachments.js'
export {
  RoomHost,
  memoryRegistry,
  type DiscoveryLike,
  type FailedRoom,
  type RoomHostOptions,
  type RoomRecord,
  type RoomRegistry,
  type AttributedMessage,
  type AuthorChecks,
  type RoomAvailability,
  type RoomState,
  type SwarmLike
} from './host.js'
export {
  Presence,
  TYPING_REFRESH,
  TYPING_TTL,
  type PresenceOptions,
  type PresencePeer,
  type PresenceState
} from './presence.js'
