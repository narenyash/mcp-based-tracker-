import { Link } from 'react-router';
import type { ActivityDto } from '@teamtrack/shared';
import { describeActivity, fullDate, NOUN, timeAgo } from '../../lib/collab';

const pathOf = (a: ActivityDto) =>
  a.entityType === 'ticket'
    ? `/tickets?ticket=${a.entityId}`
    : a.projectId
      ? `/projects/${a.projectId}?task=${a.entityId}`
      : null;

/** What others recently did on tasks and tickets I'm assigned to or testing. */
export function RecentActivity({ items }: { items: ActivityDto[] }) {
  if (!items.length)
    return <p className="py-3 text-sm text-muted">No recent activity on your work</p>;
  return (
    <ol className="space-y-2">
      {items.map((a) => {
        const path = pathOf(a);
        return (
          <li key={a.id} className="flex gap-2 text-sm leading-5 text-muted">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-subtle" />
            <p className="min-w-0 break-words">
              {path ? (
                <Link to={path} className="job-tag mr-1.5 transition-colors hover:text-fg">
                  {a.entityKey}
                </Link>
              ) : (
                <span className="job-tag mr-1.5">{a.entityKey}</span>
              )}
              <span className="font-medium text-fg">{a.actor?.name ?? 'Someone'}</span>{' '}
              {describeActivity(a, NOUN[a.entityType]).map((part, i) =>
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
        );
      })}
    </ol>
  );
}
