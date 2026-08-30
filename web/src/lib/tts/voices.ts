import type { VoiceId } from '../../types'

/**
 * The format's default voice key — the spike's proven `en_US-hfc_female-medium`.
 *
 * The curated catalog + OPFS model downloads were removed with on-device
 * synthesis (native pivot, ADR-0015); this constant survives as the default
 * for stored settings and the bundle-export fallback voice.
 */
export const DEFAULT_VOICE_ID: VoiceId = 'en_US-hfc_female-medium' as VoiceId
