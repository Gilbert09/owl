import React from 'react';
import { captureAnalyticsException } from '../lib/analytics';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Top-level React error boundary. Without it, any uncaught render exception
 * unmounts the whole tree and leaves a permanent white screen. Instead we
 * show a recovery card with a Reload button and report the exception to
 * analytics so it's visible in error tracking.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    captureAnalyticsException(error, {
      source: 'error_boundary',
      component_stack: errorInfo.componentStack ?? undefined,
    });
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-full max-w-sm p-8 space-y-4 rounded-lg border bg-card shadow-sm text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            Talyn hit an unexpected error. Reloading usually fixes it — your
            data is safe on the server.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
