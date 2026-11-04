import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import type { NotificationDto } from '@teamtrack/shared';
import { notificationsApi } from '../api/endpoints';
import { errorMessage } from '../lib/errors';
import { qk } from '../lib/tasks';
import { toastError } from '../stores/toast';
import { Avatar, cx, Spinner } from './ui';

const unreadKey = [...qk.notifications, 'unread'] as const;
const listKey = [...qk.notifications, 'list'] as const;

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Bell with unread badge. New notifications arrive over the socket; polling is only a fallback. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const unread = useQuery({ queryKey: unreadKey, queryFn: notificationsApi.unreadCount, refetchInterval: 120_000 });
  const count = unread.data ?? 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded p-1.5 text-muted hover:bg-hover hover:text-fg"
        aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell className="size-4" strokeWidth={1.75} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink text-ink-fg px-1 text-2xs leading-none font-medium tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && <Panel onClose={() => setOpen(false)} hasUnread={count > 0} />}
    </div>
  );
}

function Panel({ onClose, hasUnread }: { onClose: () => void; hasUnread: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => notificationsApi.list({ limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.notifications });
  const readAll = useMutation({ mutationFn: notificationsApi.markAllRead, onSuccess: refresh, onError: (e) => toastError(errorMessage(e)) });
  const readOne = useMutation({ mutationFn: notificationsApi.markRead, onSuccess: refresh });

  const openItem = (n: NotificationDto) => {
    if (!n.readAt) readOne.mutate(n.id);
    onClose();
    navigate(n.path);
  };
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-bg shadow-lg md:right-auto md:left-0">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">Notifications</h2>
        {hasUnread && (
          <button onClick={() => readAll.mutate()} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg">
            <CheckCheck className="size-3.5" />
            Mark all read
          </button>
        )}
      </header>
      <div className="max-h-[60vh] overflow-y-auto">
        {list.isPending ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : list.isError ? (
          <p className="p-4 text-sm text-muted">{errorMessage(list.error)}</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">You're all caught up</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <li key={n.id}>
                <button onClick={() => openItem(n)} className={cx('flex w-full gap-3 px-3 py-2.5 text-left hover:bg-hover', !n.readAt && 'bg-surface')}>
                  <span className="pt-0.5">
                    {n.actor ? <Avatar name={n.actor.name} size={24} /> : <span className="flex size-6 items-center justify-center rounded-full bg-hover text-muted"><Bell className="size-3" /></span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-[13px] leading-snug', !n.readAt && 'font-medium')}>{n.title}</span>
                    <span className="block truncate text-xs text-muted">{n.body}</span>
                    {n.note && <span className="mt-1 line-clamp-2 block text-xs text-muted">{n.note}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className="text-2xs text-subtle tabular-nums">{timeAgo(n.createdAt)}</span>
                    {!n.readAt && <span className="size-1.5 rounded-full bg-ink" aria-label="Unread" />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage} className="w-full border-t border-border py-2 text-xs text-muted hover:bg-hover hover:text-fg">
            {list.isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        )}
      </div>
    </div>
  );
}
