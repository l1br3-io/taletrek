import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import type { ReactElement } from 'react'
import type { ConnectionTestResult } from '../../../lib/ai/connection-test'

function networkGuidance(corsSafe: boolean): { label: string; detail: string } {
  return corsSafe
    ? {
        label: 'Network error — often rate-limited',
        detail:
          'The browser could not read the response. This usually means a rate limit (429) or server error whose body was blocked — check the browser Network tab or retry shortly.',
      }
    : {
        label: 'CORS / network error',
        detail:
          'The endpoint may not allow browser requests (missing CORS headers) or is unreachable. Use a CORS-safe provider or add a proxy.',
      }
}

export function TestResultPill({
  result,
  corsSafe,
}: {
  result: ConnectionTestResult
  corsSafe: boolean
}): ReactElement {
  switch (result.type) {
    case 'success':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
        </span>
      )
    case 'auth-error':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> Invalid key
        </span>
      )
    case 'model-not-found':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> Model not found
        </span>
      )
    case 'network': {
      const g = networkGuidance(corsSafe)
      return (
        <span
          className="inline-flex items-center gap-1 text-xs font-medium text-warning"
          title={g.detail}
        >
          <AlertTriangle className="h-3.5 w-3.5" /> {g.label}
        </span>
      )
    }
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
          <XCircle className="h-3.5 w-3.5" /> {result.status}
        </span>
      )
  }
}
