/**
 * Typed-error hierarchy for every `.taletrek` bundle failure. The `name`
 * field is the discriminator at the UI boundary — the import/export
 * components map each `name` to a user-readable toast, so no `any`/`unknown`
 * crosses the seam. Mirrors `backup.ts`'s `CorruptBackupError` pattern,
 * generalised to a base class so `instanceof BundleError` is the catch-all.
 */

import type { ManifestSchemaVersion } from './manifest'

/** Base for every bundle failure. Concrete subclasses set their own `name`. */
export abstract class BundleError extends Error {
  override readonly name: string = 'BundleError'
}

/**
 * `manifest.schemaVersion` is missing or not a known major. Readers MUST
 * refuse with this — never best-effort load a newer format (`bundle-format.md`
 * §Conformance). Carries the found value + the versions this build supports so
 * the message can tell the user to upgrade.
 */
export class UnsupportedSchemaVersionError extends BundleError {
  override readonly name = 'UnsupportedSchemaVersionError'
  constructor(
    readonly found: number,
    readonly supported: readonly ManifestSchemaVersion[],
  ) {
    super(
      `Bundle schemaVersion ${found} is unsupported (this SPA understands ${supported.join(', ')})`,
    )
  }
}

/**
 * The archive is not a ZIP, is truncated, or is missing a required entry
 * (`manifest.json` or `text.json`). The reader treats any structural problem
 * as corruption rather than guessing.
 */
export class CorruptBundleError extends BundleError {
  override readonly name = 'CorruptBundleError'
  constructor(reason: string) {
    super(`Bundle is corrupt: ${reason}`)
  }
}

/**
 * `manifest.kind` is present but not `"book"`. Covers the `.taletrek-lib`
 * (library) refusal: library bundles are not yet supported by the SPA in this
 * effort (detected + refused, never crashes).
 */
export class UnsupportedBundleKindError extends BundleError {
  override readonly name = 'UnsupportedBundleKindError'
  constructor(readonly found: string) {
    super(
      `This bundle has kind="${found}" and is not supported by the SPA (library bundles are not yet supported)`,
    )
  }
}

/** `manifest.audio.codec` is one the SPA cannot play (reader-accept set: Opus + M4A + WAV). */
export class UnsupportedAudioCodecError extends BundleError {
  override readonly name = 'UnsupportedAudioCodecError'
  constructor(readonly found: string) {
    super(`Bundle audio codec "${found}" is not playable in this SPA`)
  }
}

/**
 * Import would exceed the device's storage quota. Pre-flighted by the importer
 * via `navigator.storage.estimate()` before any IDB writes. Sibling of
 * `backup.ts`'s `BackupTooLargeError` (same shape, same UX).
 */
export class BundleTooLargeError extends BundleError {
  override readonly name = 'BundleTooLargeError'
  constructor() {
    super("Import would exceed this device's storage quota. Free up space and try again.")
  }
}

/**
 * Full export was requested for a book with no synthesized audio recoverable
 * from the cache (no `audioCache` entries owned by the book and no paused
 * `uploadJob` whose voice could anchor a payload). The full-audio payload
 * cannot be built, so the egress path refuses; text-only export remains
 * available and is what the message points the user at (resolved decision #2).
 */
export class NoAudioToExportError extends BundleError {
  override readonly name = 'NoAudioToExportError'
  constructor() {
    super(
      'This book has no synthesized audio to export. Export a text-only bundle instead and synth it on the desktop.',
    )
  }
}
