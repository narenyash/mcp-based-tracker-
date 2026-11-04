import { useCallback, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityType } from '@teamtrack/shared';
import { activityApi } from '../../api/collab';
import { ck, describeActivity, fullDate, NOUN, refreshActivity, timeAgo, useOnEntityChange } from '../../lib/collab';
import { errorMessage } from '../../lib/errors';
import { Button, ErrorNote, Spinner } from '../ui';

export interface ActivityFeedProps {
  entityType: EntityType;
  entityId: string;
  /** Whether the viewer may add to it (from the entity's own permissions). */
  canWrite: boolean;
}

/** How many entries show before "Show all". */
const COLLAPSED = 5;

/** Append-only history of changes to an entity, newest first, collapsed to the latest few. */
export function ActivityFeed({ entityType, entityId }: ActivityFeedProps) {
  const qc = useQueryClient();
  const ref = { entityType, entityId };
  const [expanded, setExpanded] = useState(false);
  const feed = useInfiniteQuery({
    queryKey: ck.activity(ref),
    queryFn: ({ pageParam }) => activityApi.list(ref, { cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Edits made in the drawer (or arriving over the socket) update the entity's cache; follow them here.
  const refresh = useCallback(() => refreshActivity(qc, { entityType, entityId }), [qc, entityType, entityId]);
  useOnEntityChange(ref, refresh);

  const entries = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const shown = expanded ? entries : entries.slice(0, COLLAPSED);
  const hidden = entries.length - shown.length;

  return (
    <section aria-labelledby={`activity-${entityId}`}>
      <h3 id={`activity-${entityId}`} className="mb-2 text-xs font-medium text-muted">
        Activity
      </h3>
      {feed.isPending ? (
        <Spinner />
      ) : feed.isError ? (
        <ErrorNote>{errorMessage(feed.error)}</ErrorNote>
      ) : entries.length === 0 ? (
        <p className="text-xs text-subtle">No activity yet</p>
      ) : (
        <>
          <ol className="space-y-1.5">
            {shown.map((a) => (
              <li key={a.id} className="flex gap-2 text-xs leading-5 text-muted">
                <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-subtle" />
                <p className="min-w-0 break-words">
                  <span className="font-medium text-fg">{a.actor?.name ?? 'Someone'}</span>{' '}
                  {describeActivity(a, NOUN[entityType]).map((part, i) =>
                    typeof part === 'string' ? (
                      <span key={i}>{part}</span>
                    ) : (
                      <span key={i} className="text-fg">
                        {part.value}
                      </span>
                    ),
                  )}
                  <span className="text-subtle">
                    {' · '}
                    <time dateTime={a.at} title={fullDate(a.at)}>
                      {timeAgo(a.at)}
                    </time>
                  </span>
                </p>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex gap-1">
            {hidden > 0 || (!expanded && feed.hasNextPage) ? (
              <Button size="sm" variant="ghost" className="-ml-2.5" onClick={() => setExpanded(true)}>
                Show all{hidden > 0 && !feed.hasNextPage ? ` (${entries.length})` : ''}
              </Button>
            ) : expanded && feed.hasNextPage ? (
              <Button size="sm" variant="ghost" className="-ml-2.5" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                Show older
              </Button>
            ) : null}
            {expanded && entries.length > COLLAPSED && (
              <Button size="sm" variant="ghost" className={feed.hasNextPage ? '' : '-ml-2.5'} onClick={() => setExpanded(false)}>
                Show less
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
