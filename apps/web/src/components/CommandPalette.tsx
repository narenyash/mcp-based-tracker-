import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  CircleCheck,
  Clock,
  CornerDownLeft,
  FolderKanban,
  LifeBuoy,
  MessageSquareText,
  PenTool,
  Plus,
  Search,
  Target,
  User,
  type LucideProps,
} from 'lucide-react';
import type { SearchHitType } from '@teamtrack/shared';
import { searchApi } from '../api/planning';
import { useDebounced } from '../lib/hooks';
import { errorMessage } from '../lib/errors';
import { planningKeys, readRecentSearches, rememberSearch } from '../lib/planning';
import { cx, Spinner } from './ui';

type Icon = ComponentType<LucideProps>;

const TYPE_META: Record<SearchHitType, { label: string; icon: Icon }> = {
  task: { label: 'Tasks', icon: CircleCheck },
  ticket: { label: 'Tickets', icon: LifeBuoy },
  goal: { label: 'Goals', icon: Target },
  board: { label: 'Whiteboards', icon: PenTool },
  project: { label: 'Projects', icon: FolderKanban },
  user: { label: 'People', icon: User },
};

const QUICK_ACTIONS: { label: string; path: string; icon: Icon }[] = [
  { label: 'Go to My work', path: '/my-work', icon: CircleCheck },
  { label: 'Go to Tickets', path: '/tickets', icon: LifeBuoy },
  { label: 'Go to Calendar', path: '/calendar', icon: CalendarDays },
  { label: 'Go to Standups', path: '/standups', icon: MessageSquareText },
  { label: 'New task…', path: '/projects', icon: Plus },
];

interface Item {
  key: string;
  label: string;
  sub?: string;
  icon: Icon;
  run: () => void;
}

interface Section {
  title: string;
  items: Item[];
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Phase 8: global search (Ctrl+K / Cmd+K, or "/" outside text fields). Mounted once in AppShell;
 * renders a closed native <dialog> until opened.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const q = useDebounced(query.trim(), 200);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setRecent(readRecentSearches());
      d.showModal();
      input.current?.focus();
    }
    if (!open && d.open) d.close();
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const results = useQuery({
    queryKey: planningKeys.search(q),
    queryFn: ({ signal }) => searchApi.search(q, signal),
    enabled: open && q.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const go = (path: string, remember?: string) => {
    if (remember) setRecent(rememberSearch(remember));
    setOpen(false);
    navigate(path);
  };

  const sections = useMemo<Section[]>(() => {
    if (!query.trim()) {
      const out: Section[] = [];
      if (recent.length) {
        out.push({
          title: 'Recent',
          items: recent.map((r) => ({ key: `recent:${r}`, label: r, icon: Clock, run: () => setQuery(r) })),
        });
      }
      out.push({ title: 'Quick actions', items: QUICK_ACTIONS.map((a) => ({ key: `go:${a.path}:${a.label}`, label: a.label, icon: a.icon, run: () => go(a.path) })) });
      return out;
    }
    return (results.data?.groups ?? []).map((g) => ({
      title: TYPE_META[g.type].label,
      items: g.items.map((h) => ({ key: `${h.type}:${h.id}`, label: h.title, sub: h.subtitle, icon: TYPE_META[h.type].icon, run: () => go(h.path, q) })),
    }));
    // `go` only closes over stable setters and navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, recent, results.data, q]);

  const items = sections.flatMap((s) => s.items);
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[current]?.run();
    }
  };

  const searching = query.trim().length > 0;
  const waiting = searching && (q !== query.trim() || results.isFetching) && !results.data;
  let index = -1;

  return (
    <dialog
      ref={dialog}
      aria-label="Search"
      onClose={() => setOpen(false)}
      onClick={(e) => e.target === dialog.current && setOpen(false)}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl rounded-lg border border-border bg-bg p-0 text-fg shadow-xl"
    >
      {open && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-subtle" />
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Search"
              maxLength={80}
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items.length ? optionId(current) : undefined}
              className="h-11 flex-1 bg-transparent text-sm placeholder:text-subtle focus:outline-none"
            />
            {results.isFetching && searching && <Spinner className="size-3.5" />}
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-2xs text-subtle sm:inline">Esc</kbd>
          </div>

          <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
            {results.isError && searching ? (
              <p className="px-3 py-6 text-center text-sm text-danger">{errorMessage(results.error)}</p>
            ) : waiting ? (
              <p className="px-3 py-6 text-center text-sm text-muted">Searching…</p>
            ) : searching && !items.length ? (
              <p className="px-3 py-6 text-center text-sm text-muted">No results for “{query.trim()}”</p>
            ) : (
              <ul id={listId} role="listbox" aria-label="Results">
                {sections.map((s) => (
                  <li key={s.title} role="presentation">
                    <p className="px-2.5 pt-2 pb-1 text-2xs font-medium text-subtle">{s.title}</p>
                    <ul role="presentation">
                      {s.items.map((item) => {
                        index++;
                        const i = index;
                        const Icon = item.icon;
                        return (
                          <li
                            key={item.key}
                            id={optionId(i)}
                            role="option"
                            aria-selected={i === current}
                            onMouseMove={() => i !== current && setActive(i)}
                            onClick={item.run}
                            className={cx('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5', i === current && 'bg-hover')}
                          >
                            <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{item.label}</span>
                              {item.sub && <span className="block truncate text-2xs text-subtle">{item.sub}</span>}
                            </span>
                            {i === current && <CornerDownLeft className="size-3.5 shrink-0 text-subtle" />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-2xs text-subtle">
            <span>↑↓ to move</span>
            <span>Enter to open</span>
            <span className="ml-auto">Ctrl K</span>
          </div>
        </>
      )}
    </dialog>
  );
}
