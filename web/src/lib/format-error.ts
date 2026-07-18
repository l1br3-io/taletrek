/**
 * Format an unknown error value as a flat, primitive-only string suitable
 * for `console.*` calls observed through vConsole on iOS.
 *
 * Why this exists: vConsole (mounted in `SettingsProvider`) intercepts
 * `console.error`/`console.warn` and tries to JSON-serialize every argument.
 * When an argument is a raw `Error`/`DOMException` whose properties are
 * prototype getters (or, worse, a WASM-thrown Number whose serialization
 * differs across JS engines), vConsole's serializer catches and renders the
 * placeholder `(PARSE_ERROR)` — masking the real error. The device-side
 * "DomException PARSE_ERROR" logs that prompted the piper-boundary rewrite
 * were exactly this artifact.
 *
 * The fix is to never pass raw error objects as console args. `formatError`
 * extracts the useful bits (name, message, code, first stack frame) into a
 * string — strings are primitives, so vConsole renders them verbatim.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || err.constructor?.name || 'Error'
    const msg = err.message || ''
    const code = (err as DOMException).code
    const codePart = typeof code === 'number' && code !== 0 ? ` (code ${code})` : ''
    // Skip the first stack line ("Name: message") — it duplicates `msg` —
    // and keep the first *frame* so we know where it threw.
    const stackLines = err.stack?.split('\n') ?? []
    const frame = stackLines
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    const framePart = frame ? ` @ ${frame}` : ''
    return `${name}${codePart}: ${msg}${framePart}`
  }
  // Non-Error throws (numbers from WASM EH, strings, plain objects).
  // Primitives render as bare String(); class instances get a constructor
  // prefix so the type is visible (e.g. "TypeError: bad type" already goes
  // through the Error branch above, but a thrown PlainObject would land here).
  if (typeof err === 'object' && err !== null) {
    const ctor = (err as { constructor?: { name?: string } }).constructor?.name
    return ctor && ctor !== 'Object' ? `${ctor}: ${String(err)}` : String(err)
  }
  return String(err)
}
