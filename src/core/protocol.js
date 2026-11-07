// Wire constants shared by the host (Node) and the guest bundle (browser). No imports.
export const TEXT_KEY = 'md'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
// Server -> client only. Payload: varUint 1 = frozen (read-only). Guests register a
// handler at this index in provider.messageHandlers (y-websocket 3.x extension point).
export const MSG_FROZEN = 100

export const CLOSE = Object.freeze({
  STOPPED: 4000, // host stopped sharing
  STALE_EPOCH: 4001, // client belongs to an old epoch; must drop its doc
  TOO_LARGE_DOC: 4002 // update would push document past the size limit
})
