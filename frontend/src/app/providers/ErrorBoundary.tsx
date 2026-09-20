import { TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Top-level error boundary.
 *
 * A render crash in a PWA has no browser error page to fall back on — the
 * shopkeeper just gets a white screen mid-sale. This catches that and offers
 * the two things that actually help: reload, or go back to the home screen.
 *
 * Deliberately a class component: React still offers no hook equivalent.
 */

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // In production this is where a monitoring client would receive the error.
    // Logging it keeps the detail available in the console either way.
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-[var(--color-bg)] px-6 text-center">
        <TriangleAlert className="size-12 text-[var(--color-warning)]" aria-hidden="true" />

        <div className="max-w-sm">
          <h1 className="text-xl font-bold text-[var(--color-ink)]">
            Something went wrong on our side
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
            Your data is safe. Reloading usually fixes it.
          </p>

          {import.meta.env.DEV ? (
            <pre className="mt-4 max-h-48 overflow-auto rounded-[var(--radius-field)] bg-[var(--color-sunken)] p-3 text-left font-mono text-[11px] leading-relaxed text-[var(--color-danger)]">
              {error.message}
              {'\n'}
              {error.stack}
            </pre>
          ) : null}
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-11 rounded-[var(--radius-field)] bg-[var(--color-primary)] px-5 text-sm font-semibold text-[var(--color-primary-ink)]"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              // Full navigation rather than router push: the router itself may
              // be the thing that broke.
              window.location.href = '/app';
            }}
            className="h-11 rounded-[var(--radius-field)] border border-[var(--color-line-strong)] px-5 text-sm font-semibold text-[var(--color-ink)]"
          >
            Go home
          </button>
        </div>
      </div>
    );
  }
}
