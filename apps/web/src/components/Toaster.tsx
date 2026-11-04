import { useToasts } from '../stores/toast';
import { cx } from './ui';

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            'pointer-events-auto rounded-md border border-border bg-bg px-4 py-2.5 text-sm shadow-lg',
            t.tone === 'error' && 'text-danger',
          )}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
