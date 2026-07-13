import type { BookId, VoiceId } from '../../types'

export type TtsRequest =
  | { id: number; op: 'synthesize'; text: string; voiceId: VoiceId; bookId?: BookId }
  | { id: number; op: 'download'; voiceId: VoiceId }
  | { id: number; op: 'isStored'; voiceId: VoiceId }
  | { id: number; op: 'remove'; voiceId: VoiceId }

export type TtsResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'success'; op: 'synthesize'; audio: Blob; synthMs: number }
  | { id: number; type: 'success'; op: 'isStored'; stored: boolean }
  | { id: number; type: 'success'; op: 'download' }
  | { id: number; type: 'success'; op: 'remove' }
  | { id: number; type: 'error'; message: string }

/** A success response of any op — the resolved payload from `request`. */
export type TtsSuccess = Extract<TtsResponse, { type: 'success' }>
/** A request without its correlation `id` — distributes over the union so the
 *  `op` discriminator stays usable when constructing a request body. */
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
export type TtsRequestBody = WithoutId<TtsRequest>
