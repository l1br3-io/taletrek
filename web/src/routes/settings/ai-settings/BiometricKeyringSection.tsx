import { Fingerprint, Lock, ShieldCheck, ShieldX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { hasAnyKey } from '../../../lib/ai/keyring'

/**
 * Probe state for the biometric tier. `probing` runs once on mount; the section
 * is hidden entirely when PRF is unsupported so users on old Safari / Firefox
 * see no change from ADR-0004's default.
 */
type BiometricState =
  | { type: 'probing' }
  | { type: 'unsupported' }
  | { type: 'not-enrolled' }
  | { type: 'enrolled-locked' }
  | { type: 'enrolled-unlocked' }

interface BiometricKeyringSectionProps {
  /** Current opt-in flag from `ai.cloud.biometricUnlock`. When `true`, the
   * "Turn off & forget" button is always shown — even if the IDB record is
   * missing or the probe failed — so the user always has an escape hatch. */
  enabled: boolean
  /** Called when the user successfully enrolls (true) or forgets (false). */
  onEnabledChange: (next: boolean) => void
}

/**
 * Opt-in biometric key caching (ADR-0007). Single toggle wraps every provider
 * key in the in-memory keyring behind one passkey. Hidden when WebAuthn PRF is
 * unavailable; falls back silently to the in-memory tier (ADR-0004) on user
 * cancel or tamper.
 *
 * Copy is deliberately honest: "biometric gate, not a vault" — the CSP
 * allowlist remains the primary exfiltration defence, and an unlocked key is
 * still readable by same-origin JS for the rest of the session.
 */
export function BiometricKeyringSection({
  enabled,
  onEnabledChange,
}: BiometricKeyringSectionProps) {
  const [state, setState] = useState<BiometricState>({ type: 'probing' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Probe once. Dynamic import keeps secure-keyring + WebAuthn code out of the
  // initial bundle for users who never opt in.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [{ isPrfSupported }, { getSnapshot }] = await Promise.all([
          import('../../../lib/crypto/prf'),
          import('../../../lib/ai/secure-keyring'),
        ])
        const supported = await isPrfSupported()
        if (cancelled) return
        if (!supported) {
          setState({ type: 'unsupported' })
          return
        }
        const snap = await getSnapshot()
        if (cancelled) return
        setState(
          snap.enrolled
            ? snap.unlocked
              ? { type: 'enrolled-unlocked' }
              : { type: 'enrolled-locked' }
            : { type: 'not-enrolled' },
        )
      } catch {
        if (!cancelled) setState({ type: 'unsupported' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.type === 'probing' || state.type === 'unsupported') return null

  const transition = (next: BiometricState): void => setState(next)

  const handleEnable = async (): Promise<void> => {
    setError(null)
    if (!hasAnyKey()) {
      setError('Add at least one provider key first, then enable biometric caching.')
      return
    }
    setBusy(true)
    try {
      const { enroll } = await import('../../../lib/ai/secure-keyring')
      await enroll()
      onEnabledChange(true)
      transition({ type: 'enrolled-unlocked' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Biometric enrollment failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleUnlock = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { unlock } = await import('../../../lib/ai/secure-keyring')
      const result = await unlock()
      if (result.keysLoaded === 0) {
        setError('No cached keys found. Re-enter a key, then re-enable biometric caching.')
      } else {
        transition({ type: 'enrolled-unlocked' })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Biometric unlock failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleForget = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { forget } = await import('../../../lib/ai/secure-keyring')
      await forget()
      onEnabledChange(false)
      transition({ type: 'not-enrolled' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable biometric caching.')
    } finally {
      setBusy(false)
    }
  }

  // IDB says enrolled (locked or unlocked).
  const idbEnrolled = state.type === 'enrolled-locked' || state.type === 'enrolled-unlocked'
  // Settings flag says opted in. When true but IDB doesn't agree, the state is
  // inconsistent (e.g. record was cleared manually, or probe failed). Either
  // way the user needs an escape hatch — always show Forget when enabled.
  const showForget = enabled || idbEnrolled
  // Flag-on but no IDB record → stale/inconsistent. Show a heads-up.
  const staleFlag = enabled && state.type === 'not-enrolled'

  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg p-3">
      <div className="flex items-start gap-2">
        <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">Remember keys with biometric</span>
            {idbEnrolled && (
              <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-xs font-medium text-success">
                {state.type === 'enrolled-unlocked' ? (
                  <>
                    <ShieldCheck className="h-3 w-3" /> Unlocked
                  </>
                ) : (
                  <>
                    <Lock className="h-3 w-3" /> Locked
                  </>
                )}
              </span>
            )}
          </div>
          <p className="text-xs text-muted">
            Cache your provider keys behind your device biometric (Touch ID / Face ID / Windows
            Hello / security key). One tap restores them on the next visit. The cached blob is
            encrypted — it's useless without your device + biometric.
          </p>
          <p className="text-xs text-muted">
            <ShieldX className="mr-1 inline h-3 w-3" />
            <strong className="text-fg">Honest framing:</strong> this is a biometric gate, not a
            vault. Same-origin scripts (XSS, malicious extensions) can still read an unlocked key
            for the rest of the session. Use scoped, spend-capped provider keys regardless.
          </p>

          {staleFlag && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              Biometric caching is enabled but no encrypted cache was found on this device. Click
              "Turn off &amp; forget" to reset, then re-enable if desired.
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {!idbEnrolled && !staleFlag && (
              <button
                type="button"
                onClick={() => void handleEnable()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
              >
                <Fingerprint className="h-3.5 w-3.5" /> {busy ? 'Enrolling…' : 'Enable'}
              </button>
            )}
            {state.type === 'enrolled-locked' && (
              <button
                type="button"
                onClick={() => void handleUnlock()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" /> {busy ? 'Unlocking…' : 'Unlock now'}
              </button>
            )}
            {showForget && (
              <button
                type="button"
                onClick={() => void handleForget()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
              >
                <ShieldX className="h-3.5 w-3.5" /> Turn off &amp; forget
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
