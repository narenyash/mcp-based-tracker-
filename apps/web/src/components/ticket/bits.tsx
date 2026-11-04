import { useEffect, useState } from 'react';
import { Bug, CircleAlert, CircleHelp, Flame, Inbox, SignalHigh, SignalLow, SignalMedium, TriangleAlert } from 'lucide-react';
import type { TicketSeverity, TicketType } from '@teamtrack/shared';
import { SEVERITY_LABEL, TYPE_LABEL } from '../../lib/tickets';
import { cx, Textarea } from '../ui';

export function TypeIcon({ type, className }: { type: TicketType; className?: string }) {
  const props = { className: cx('size-3.5 shrink-0 text-muted', className), strokeWidth: 2, 'aria-label': TYPE_LABEL[type] };
  switch (type) {
    case 'bug':
      return <Bug {...props} />;
    case 'issue':
      return <TriangleAlert {...props} />;
    case 'request':
      return <Inbox {...props} />;
    case 'question':
      return <CircleHelp {...props} />;
    case 'incident':
      return <Flame {...props} className={cx(props.className, 'text-danger')} />;
  }
}

export function SeverityIcon({ severity, className }: { severity: TicketSeverity; className?: string }) {
  const props = { className: cx('size-3.5 shrink-0', className), strokeWidth: 2, 'aria-label': `${SEVERITY_LABEL[severity]} severity` };
  switch (severity) {
    case 'critical':
      return <CircleAlert {...props} className={cx(props.className, 'text-danger')} />;
    case 'high':
      return <SignalHigh {...props} />;
    case 'medium':
      return <SignalMedium {...props} />;
    case 'low':
      return <SignalLow {...props} className={cx(props.className, 'text-muted')} />;
  }
}

/** Text that saves on blur (or Enter for single-line). Keeps local edits until the server value changes. */
export function InlineText({
  value,
  onSave,
  disabled,
  multiline,
  className,
  ariaLabel,
  placeholder,
  required,
  maxLength,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  className?: string;
  ariaLabel: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = multiline ? draft : draft.trim();
    if (next === value) return;
    if (required && !next) return setDraft(value);
    onSave(next);
  };
  const shared = {
    'aria-label': ariaLabel,
    value: draft,
    disabled,
    placeholder,
    onBlur: commit,
    className: cx('w-full rounded-md border border-transparent bg-transparent px-2 py-1 -mx-2 hover:border-border focus:border-fg focus:outline-none disabled:hover:border-transparent', className),
  };
  return multiline ? (
    <Textarea {...shared} rows={Math.min(14, Math.max(2, draft.split('\n').length + 1))} maxLength={maxLength ?? 20_000} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...shared}
      maxLength={maxLength ?? 200}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}
