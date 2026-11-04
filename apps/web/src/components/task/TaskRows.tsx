import type { LabelDto, TaskDto, WorkflowStatusDto } from '@teamtrack/shared';
import { Avatar } from '../ui';
import { DueDate, LabelChip, PriorityIcon, StatusDot, TestingBadge } from './bits';

const CATEGORY_FALLBACK: Record<TaskDto['statusCategory'], WorkflowStatusDto> = {
  todo: { id: 'todo', name: 'To do', category: 'todo', color: '#a3a3a3', order: 0 },
  in_progress: { id: 'in_progress', name: 'In progress', category: 'in_progress', color: '#3b82f6', order: 1 },
  testing: { id: 'testing', name: 'Testing', category: 'testing', color: '#f59e0b', order: 2 },
  done: { id: 'done', name: 'Done', category: 'done', color: '#22c55e', order: 3 },
};

/** Dense, responsive task rows used by the project list view and My work. */
export function TaskRows({
  tasks,
  statusOf,
  labelsOf,
  projectOf,
  onOpen,
}: {
  tasks: TaskDto[];
  statusOf: (t: TaskDto) => WorkflowStatusDto | undefined;
  labelsOf?: (t: TaskDto) => LabelDto[];
  projectOf?: (t: TaskDto) => { name: string; color: string } | undefined;
  onOpen: (t: TaskDto) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {tasks.map((t) => {
        const status = statusOf(t) ?? CATEGORY_FALLBACK[t.statusCategory];
        const project = projectOf?.(t);
        return (
          <li key={t.id}>
            <button onClick={() => onOpen(t)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover">
              <PriorityIcon priority={t.priority} />
              <span className="w-20 shrink-0"><span className="job-tag">{t.key}</span></span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={t.statusCategory === 'done' ? 'text-sm text-muted' : 'text-sm'}>{t.title}</span>
                  {labelsOf?.(t).map((l) => <LabelChip key={l.id} label={l} />)}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {project && (
                    <span className="inline-flex items-center gap-1 text-2xs text-muted">
                      <span className="size-1.5 rounded-full" style={{ background: project.color }} />
                      {project.name}
                    </span>
                  )}
                  <TestingBadge task={t} />
                  <DueDate task={t} />
                  {t.reporter && <span className="text-2xs text-subtle">created by {t.reporter.name}</span>}
                </span>
              </span>
              <span className="hidden w-28 shrink-0 items-center gap-1.5 text-xs text-muted sm:flex">
                <StatusDot color={status.color} />
                <span className="truncate">{status.name}</span>
              </span>
              <span className="w-5 shrink-0" title={t.assignee ? `Assigned to ${t.assignee.name}` : 'Unassigned'}>
                {t.assignee ? <Avatar name={t.assignee.name} size={20} /> : <span className="block size-5 rounded-full border border-dashed border-border" />}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
