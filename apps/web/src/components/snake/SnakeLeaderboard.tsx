import type { SnakeLeaderboardDto, SnakeLeaderboardEntryDto } from '@teamtrack/shared';
import { Avatar, cx } from '../ui';

const pad4 = (n: number) => String(n).padStart(4, '0');

/** Top scores in the workspace, with my own row pinned underneath when I'm not in the list. */
export function SnakeLeaderboard({ data }: { data: SnakeLeaderboardDto }) {
  if (!data.top.length)
    return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No scores yet. Set the first one</p>;
  const meInTop = !!data.me && data.top.some((e) => e.user.id === data.me!.user.id);
  return (
    <div>
      <ol className="divide-y divide-border rounded-lg border border-border">
        {data.top.map((e) => (
          <Row key={e.user.id} entry={e} me={e.user.id === data.me?.user.id} />
        ))}
      </ol>
      {data.me && !meInTop && (
        <ol className="mt-2 rounded-lg border border-border" aria-label="Your rank">
          <Row entry={data.me} me />
        </ol>
      )}
    </div>
  );
}

function Row({ entry: e, me }: { entry: SnakeLeaderboardEntryDto; me: boolean }) {
  return (
    <li
      className={cx('flex h-10 items-center gap-3 px-3', me && 'bg-hover')}
      title={`${e.games} ${e.games === 1 ? 'game' : 'games'}, best on ${new Date(e.bestAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
    >
      <span className={cx('w-5 text-right font-mono text-xs', e.rank === 1 ? 'text-ink' : 'text-subtle')}>{e.rank}</span>
      <Avatar name={e.user.name} size={22} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {e.user.name}
        {me && <span className="text-subtle"> · you</span>}
      </span>
      <span className="font-mono text-sm">{pad4(e.best)}</span>
    </li>
  );
}
