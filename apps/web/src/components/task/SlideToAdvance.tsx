import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronsRight } from 'lucide-react';
import { cx } from '../ui';

const KNOB = 44;
const PAD = 4;
/** Fraction of the track the knob must travel before release counts as "slid". */
const THRESHOLD = 0.85;

/**
 * "Slide to answer" control: drag the knob to the end to confirm. Deliberate enough to avoid
 * accidental status changes, quick enough to use one-handed on a phone. Keyboard users press
 * Enter, Space or → on the knob.
 */
export function SlideToAdvance({ label, color, onComplete, disabled }: { label: string; color: string; onComplete: () => void; disabled?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; from: number } | null>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);

  const max = () => Math.max(0, (track.current?.clientWidth ?? 0) - KNOB - PAD * 2);

  const complete = () => {
    setX(max());
    setDone(true);
    onComplete();
    // Spring back once the parent has had a moment to show the new status.
    window.setTimeout(() => {
      setDone(false);
      setX(0);
    }, 450);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || done) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, from: x };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    setX(Math.min(max(), Math.max(0, drag.current.from + e.clientX - drag.current.startX)));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (max() > 0 && x >= max() * THRESHOLD) complete();
    else setX(0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || done) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      complete();
    }
  };

  const progress = max() ? x / max() : 0;
  return (
    <div
      ref={track}
      className={cx('relative h-[52px] w-full overflow-hidden rounded-full border border-border bg-surface select-none', disabled && 'opacity-50')}
    >
      {/* Fill that follows the knob, tinted with the destination status colour. */}
      <div
        aria-hidden
        className={cx('absolute inset-y-0 left-0 rounded-full', !dragging && 'transition-[width] duration-300 ease-out')}
        style={{ width: x + KNOB + PAD * 2, background: `color-mix(in srgb, ${color} 18%, transparent)` }}
      />
      <span
        aria-hidden
        className="pointer-events-none text-muted absolute inset-0 flex items-center justify-center pl-12 text-sm font-medium"
        style={{ opacity: 1 - progress * 1.4 }}
      >
        {label}
      </span>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cx(
          'absolute top-1 left-1 flex touch-none items-center justify-center rounded-full bg-accent text-accent-fg shadow-sm',
          disabled ? 'cursor-not-allowed' : dragging ? 'cursor-grabbing' : 'cursor-grab',
          !dragging && 'transition-transform duration-300 ease-out',
        )}
        style={{ width: KNOB, height: KNOB, transform: `translateX(${x}px)` }}
      >
        <ChevronsRight className="size-5" />
      </button>
    </div>
  );
}
