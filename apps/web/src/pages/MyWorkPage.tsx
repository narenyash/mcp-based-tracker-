import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import type { TaskDto } from '@teamtrack/shared';
import { projectsApi } from '../api/endpoints';
import { errorMessage } from '../lib/errors';
import { myWorkQueries } from '../lib/tasks';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { TaskRows } from '../components/task/TaskRows';

export function MyWorkPage() {
  const navigate = useNavigate();
  const assigned = useQuery(myWorkQueries.assigned);
  const testing = useQuery(myWorkQueries.testing);
  const projects = useQuery({ queryKey: ['projects', 'active'], queryFn: () => projectsApi.list({ status: 'active' }) });
  const projectById = useMemo(() => new Map((projects.data?.items ?? []).map((p) => [p.id, p])), [projects.data]);

  const open = (t: TaskDto) => navigate(`/projects/${t.projectId}?task=${t.id}`);
  const statusOf = (t: TaskDto) => projectById.get(t.projectId)?.workflow.taskStatuses.find((s) => s.id === t.statusId);
  const projectOf = (t: TaskDto) => projectById.get(t.projectId);
  // Tasks I'm testing are shown in their own section, not again under "assigned".
  const testingIds = new Set(testing.data?.items.map((t) => t.id));
  const assignedItems = (assigned.data?.items ?? []).filter((t) => !testingIds.has(t.id));

  return (
    <>
      <PageHeader title="My work" description="Everything waiting on you, across all projects" />

      <section className="mb-10">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <FlaskConical className="size-4 text-muted" strokeWidth={1.75} />
          Waiting for my testing
          {!!testing.data?.items.length && <span className="text-xs text-subtle tabular-nums">{testing.data.items.length}</span>}
        </h2>
        {testing.isPending ? (
          <Spinner />
        ) : testing.isError ? (
          <ErrorNote>{errorMessage(testing.error)}</ErrorNote>
        ) : testing.data.items.length ? (
          <TaskRows tasks={testing.data.items} statusOf={statusOf} projectOf={projectOf} onOpen={open} />
        ) : (
          <p className="text-sm text-muted">Nothing to test right now</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          Assigned to me
          {assignedItems.length > 0 && <span className="text-xs text-subtle tabular-nums">{assignedItems.length}</span>}
        </h2>
        {assigned.isPending ? (
          <Spinner />
        ) : assigned.isError ? (
          <ErrorNote>{errorMessage(assigned.error)}</ErrorNote>
        ) : assignedItems.length ? (
          <TaskRows tasks={assignedItems} statusOf={statusOf} projectOf={projectOf} onOpen={open} />
        ) : (
          <EmptyState title="You're all caught up" description="Open tasks assigned to you will show up here, highest priority first" />
        )}
      </section>
    </>
  );
}
