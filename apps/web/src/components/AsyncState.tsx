import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading data' }: { label?: string }) {
  return (
    <div className="feedback-state" role="status" aria-live="polite">
      <span className="loading-indicator" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <section className="feedback-state feedback-error" role="alert">
      <h2>Something went wrong</h2>
      <p>{message}</p>
      {onRetry ? (
        <button className="secondary-button" type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </section>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <section className="feedback-state empty-state">
      <span className="empty-state-mark" aria-hidden="true">
        —
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </section>
  );
}
