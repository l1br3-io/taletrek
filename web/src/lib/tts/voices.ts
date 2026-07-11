import { type VoiceId, voiceId } from '../../types'
import type { Voice } from './types'

/**
 * Curated English voice catalog (~8 voices, medium quality).
 *
 * Captured from `tts.voices()` (HuggingFace `voices.json`) — real IDs + exact
 * model sizes. Static so the voice picker renders with no network call; models
 * download to OPFS on demand via `TtsEngine.download`.
 *
 * Selection: 4 US + 4 GB, the ~60 MiB medium tier (smaller than the 73 MiB
 * `x_low`-adjacent variants), mix of voices. The default is the spike's proven
 * `en_US-hfc_female-medium`.
 */
export const CURATED_VOICES: readonly Voice[] = [
  {
    id: voiceId('en_US-hfc_female-medium'),
    name: 'HFC Female',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_US',
  },
  {
    id: voiceId('en_US-ryan-medium'),
    name: 'Ryan',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_US',
  },
  {
    id: voiceId('en_US-amy-medium'),
    name: 'Amy',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_US',
  },
  {
    id: voiceId('en_US-lessac-medium'),
    name: 'Lessac',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_US',
  },
  {
    id: voiceId('en_US-kristin-medium'),
    name: 'Kristin',
    quality: 'medium',
    sizeBytes: 63531379,
    language: 'en_US',
  },
  {
    id: voiceId('en_GB-alan-medium'),
    name: 'Alan',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_GB',
  },
  {
    id: voiceId('en_GB-alba-medium'),
    name: 'Alba',
    quality: 'medium',
    sizeBytes: 63201294,
    language: 'en_GB',
  },
  {
    id: voiceId('en_GB-cori-medium'),
    name: 'Cori',
    quality: 'medium',
    sizeBytes: 63531379,
    language: 'en_GB',
  },
]

/**
 * Default voice — the spike's proven `en_US-hfc_female-medium`.
 * `getVoice(DEFAULT_VOICE_ID)` is asserted to match the catalog's first entry
 * in `voices.test.ts`, so any drift between this literal and the catalog fails
 * the test.
 */
export const DEFAULT_VOICE_ID: VoiceId = voiceId('en_US-hfc_female-medium')

/** Look up a curated voice by id, or `undefined` if not in the catalog. */
export function getVoice(id: VoiceId): Voice | undefined {
  return CURATED_VOICES.find((v) => v.id === id)
}
