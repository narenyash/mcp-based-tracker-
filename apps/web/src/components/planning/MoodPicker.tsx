import { Annoyed, Frown, Laugh, Meh, Smile, type LucideIcon } from 'lucide-react';
import { MOODS } from '../../lib/planning';
import { cx } from '../ui';

/** One line icon per mood, 1 (rough) to 5 (great). */
const MOOD_ICONS: Record<number, LucideIcon> = { 1: Frown, 2: Annoyed, 3: Meh, 4: Smile, 5: Laugh };

/** Five small faces; clicking the selected one clears it. */
export function MoodPicker({ value, onChange, disabled }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Mood" className="flex items-center gap-0.5">
      {MOODS.map((m) => {
        const selected = value === m.value;
        const Icon = MOOD_ICONS[m.value]!;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={m.label}
            title={m.label}
            disabled={disabled}
            onClick={() => onChange(selected ? null : m.value)}
            className={cx(
              'flex size-8 items-center justify-center rounded-md transition-colors disabled:pointer-events-none',
              selected ? 'bg-hover text-ink' : 'text-subtle hover:text-fg',
            )}
          >
            <Icon className="size-4" strokeWidth={1.5} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

export function MoodFace({ mood }: { mood: number | null }) {
  const m = MOODS.find((x) => x.value === mood);
  if (!m) return null;
  const Icon = MOOD_ICONS[m.value]!;
  return (
    <span title={`Mood: ${m.label}`} className="inline-flex items-center gap-1 text-xs text-subtle">
      <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
      {m.label}
    </span>
  );
}
