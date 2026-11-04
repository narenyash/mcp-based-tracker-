import { X } from 'lucide-react';
import type { CalendarItemDto } from '@teamtrack/shared';
import { formatDay } from '../../lib/planning';
import { cx, Sheet } from '../ui';

const TYPE_LABEL: Record<CalendarItemDto['type'], string> = { task: 'Task', ticket: 'Ticket', goal: 'Goal' };

/** One due item as a small coloured chip; struck through when done. */
export function CalendarChip({ item, onOpen, roomy }: { item: CalendarItemDto; onOpen: (item: CalendarItemDto) => void; roomy?: boolean }) {
  return (
    <button
      onClick={() => onOpen(item)}
      title={`${TYPE_LABEL[item.type]} ${item.key} ${item.title}${item.done ? ' (done)' : ''}`}
      className={cx(
        'flex w-full min-w-0 items-center gap-1.5 rounded text-left hover:bg-hover',
        roomy ? 'px-2 py-1.5 text-sm' : 'px-1 py-0.5 text-2xs',
        item.done && 'text-subtle line-through',
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: item.color }} />
      <span className="shrink-0 font-mono text-subtle">{item.key}</span>
      <span className="truncate">{item.title}</span>
    </button>
  );
}

/** Everything due on one day (opened from "+N more"). */
export function DaySheet({
  day,
  items,
  onClose,
  onOpen,
}: {
  day: string | null;
  items: CalendarItemDto[];
  onClose: () => void;
  onOpen: (item: CalendarItemDto) => void;
}) {
  return (
    <Sheet open={!!day} onClose={onClose} label={day ? `Due on ${formatDay(day)}` : 'Day'}>
      {day && (
        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-medium">{formatDay(day, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
            <button onClick={onClose} className="rounded p-1 text-muted hover:bg-hover" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          <ul className="space-y-0.5">
            {items.map((i) => (
              <li key={`${i.type}:${i.id}`}>
                <CalendarChip item={i} onOpen={onOpen} roomy />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}
