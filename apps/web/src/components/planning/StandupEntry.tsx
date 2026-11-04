import { Link } from 'react-router';
import type { StandupDto } from '@teamtrack/shared';
import { Avatar } from '../ui';
import { MoodFace } from './MoodPicker';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function Section({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <p className="text-2xs font-medium text-subtle">{label}</p>
      <p className="text-sm whitespace-pre-line">{text}</p>
    </div>
  );
}

/** One person's standup in the team feed. */
export function StandupEntry({ entry }: { entry: StandupDto }) {
  const hasBlockers = !!entry.blockers || entry.blockerTasks.length > 0;
  return (
    <article className="flex gap-3 py-4">
      <Avatar name={entry.user.name} size={28} />
      <div className="min-w-0 flex-1 space-y-2">
        <header className="flex items-center gap-2">
          <span className="text-sm font-medium">{entry.user.name}</span>
          <time dateTime={entry.updatedAt} className="text-xs text-subtle">
            {time(entry.updatedAt)}
          </time>
          <MoodFace mood={entry.mood} />
        </header>
        <Section label="Yesterday" text={entry.yesterday} />
        <Section label="Today" text={entry.today} />
        {hasBlockers && (
          <div className="rounded-md border-l-2 border-danger/60 bg-surface px-3 py-2">
            <p className="text-2xs font-medium text-danger">Blockers</p>
            {entry.blockers && <p className="text-sm whitespace-pre-line">{entry.blockers}</p>}
            {entry.blockerTasks.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {entry.blockerTasks.map((t) => (
                  <li key={t.id}>
                    <Link to={`/projects/${t.projectId}?task=${t.id}`} className="text-xs text-muted hover:text-fg hover:underline">
                      <span className="job-tag">{t.key}</span> {t.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!entry.yesterday && !entry.today && !hasBlockers && <p className="text-sm text-muted">Checked in</p>}
      </div>
    </article>
  );
}
