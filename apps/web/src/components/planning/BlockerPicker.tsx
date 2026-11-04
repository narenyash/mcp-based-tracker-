import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { STANDUP_MAX_BLOCKER_TASKS, type StandupTaskRefDto } from '@teamtrack/shared';
import { tasksApi } from '../../api/endpoints';
import { qk } from '../../lib/tasks';
import { useDebounced } from '../../lib/hooks';
import { cx, Input, Spinner } from '../ui';

/** Picks up to 10 tasks that block me, searched by key or title across the projects I can see. */
export function BlockerPicker({
  value,
  onChange,
  disabled,
}: {
  value: StandupTaskRefDto[];
  onChange: (v: StandupTaskRefDto[]) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: [...qk.tasks, 'blocker-search', q],
    queryFn: () => tasksApi.list({ q, state: 'open', limit: 8 }),
    enabled: q.length > 0,
    staleTime: 30_000,
  });

  const chosen = new Set(value.map((t) => t.id));
  const options = (results.data?.items ?? []).filter((t) => !chosen.has(t.id));
  const full = value.length >= STANDUP_MAX_BLOCKER_TASKS;
  const showList = focused && q.length > 0 && !full;
  const current = Math.min(active, Math.max(options.length - 1, 0));

  const add = (t: { id: string; key: string; title: string; projectId: string }) => {
    onChange([...value, { id: t.id, key: t.key, title: t.title, projectId: t.projectId }]);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((t) => (
            <li key={t.id} className="inline-flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs">
              <span className="job-tag">{t.key}</span>
              <span className="truncate">{t.title}</span>
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x.id !== t.id))} className="rounded text-muted hover:text-fg" aria-label={`Remove ${t.key}`}>
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="relative">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (!showList || !options.length) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                add(options[current]!);
              }
            }}
            disabled={full}
            placeholder={full ? `At most ${STANDUP_MAX_BLOCKER_TASKS} tasks` : 'Link a blocking task by key or title'}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && options.length ? `${listId}-${current}` : undefined}
            className="h-8 text-xs"
          />
          {showList && (
            <ul id={listId} role="listbox" className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-bg p-1 shadow-lg">
              {results.isPending ? (
                <li className="px-2 py-1.5">
                  <Spinner className="size-3.5" />
                </li>
              ) : options.length ? (
                options.map((t, i) => (
                  <li
                    key={t.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === current}
                    // mousedown, not click: the input's blur would close the list first.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(t);
                    }}
                    onMouseMove={() => setActive(i)}
                    className={cx('flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs', i === current && 'bg-hover')}
                  >
                    <span className="job-tag shrink-0">{t.key}</span>
                    <span className="truncate">{t.title}</span>
                  </li>
                ))
              ) : (
                <li className="px-2 py-1.5 text-xs text-muted">No open tasks match</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
