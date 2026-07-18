import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router'

function describeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack }
  if (isRouteErrorResponse(err)) {
    return {
      name: `Router Error ${err.status}`,
      message: typeof err.data === 'string' ? err.data : err.statusText || 'Unknown route error',
    }
  }
  return { name: 'Error', message: String(err) }
}

/**
 * Stable, lightweight error fallback shared by the route-level error element
 * and the top-level class boundary. Never auto-reloads — the user controls
 * recovery. This is deliberately minimal so it survives memory pressure that
 * would trigger an iOS Safari tab reload when RR's default error element
 * (which renders a full stack trace) is used.
 */
function ErrorFallback({
  name,
  message,
  onHome,
}: {
  name: string
  message: string
  onHome: () => void
}): ReactNode {
  return (
    <div
      role="alert"
      className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-8 text-center"
    >
      <h2 className="text-lg font-semibold text-danger">Something went wrong</h2>
      <p className="break-words text-sm text-muted">
        <span className="font-mono">{name}</span>: {message}
      </p>
      <p className="text-xs text-muted">
        Your books are safe. Check the console (vConsole) for diagnostic logs.
      </p>
      <button
        type="button"
        onClick={onHome}
        className="border border-accent px-4 py-2 text-sm font-medium transition-colors hover:bg-elevated"
      >
        Back to Library
      </button>
    </div>
  )
}

/**
 * React Router `errorElement` for the root route. Catches render/loader/action
 * errors from every descendant route. Uses `useNavigate` so recovery stays
 * client-side (no full page reload — preserves vConsole and app state).
 */
export function RouteErrorElement(): ReactNode {
  const rawError = useRouteError()
  const navigate = useNavigate()
  const { name, message, stack } = describeError(rawError)
  console.error('[taletrek] route error caught', { name, message, stack })
  return (
    <ErrorFallback
      name={name}
      message={message}
      onHome={() => navigate('/library', { replace: true })}
    />
  )
}

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Top-level React error boundary — wraps `RouterProvider` INSIDE
 * `SettingsProvider` so that vConsole (owned by SettingsProvider) survives a
 * render crash. This catches errors that escape React Router's own boundary
 * (e.g. errors in providers or RR internals). Recovery navigates to the
 * library via a full load (the boundary sits outside the router context, so
 * `useNavigate` is unavailable here).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[taletrek] render error caught by top-level boundary', {
      errName: error.name,
      errMessage: error.message,
      errStack: error.stack,
      componentStack: info.componentStack,
    })
  }

  handleHome = (): void => {
    this.setState({ error: null })
    window.location.href = '/library'
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback
          name={this.state.error.name}
          message={this.state.error.message}
          onHome={this.handleHome}
        />
      )
    }
    return this.props.children
  }
}
