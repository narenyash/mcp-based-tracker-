import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { TASK_PRIORITIES, type ProjectDto, type TaskPriority } from '@teamtrack/shared';
import { tasksApi, type TaskListParams } from '../../api/endpoints';
import { errorMessage } from '../../lib/errors';
import { useDebounced } from '../../lib/hooks';
import { qk, sortedStatuses, useAssignablePeople, useLabels } from '../../lib/tasks';
import { Button, EmptyState, ErrorNote, Input, Select, Spinner } from '../ui';
import { PRIORITY_LABEL } from './bits';
import { TaskRows } from './TaskRows';

interface Filters {
  q: string;
  state: 'open' | 'done' | 'all';
  assignee: string;
  priority: '' | TaskPriority;
  labelId: string;
  sort: 'updated' | 'created' | 'priority';
}

const INITIAL: Filters = { q: '', state: 'open', assignee: '', priority: '', labelId: '', sort: 'updated' };

export function TaskList({ project, onOpen }: { project: ProjectDto; onOpen: (taskId: string) => void }) {
  const [f, setF] = useState<Filters>(INITIAL);
  const q = useDebounced(f.q.trim());
  const { people } = useAssignablePeople(project.id);
  const labels = useLabels(project.id);
  const statusById = useMemo(() => new Map(sortedStatuses(project).map((s) => [s.id, s])), [project]);
  const labelById = useMemo(() => new Map((labels.data ?? []).map((l) => [l.id, l])), [labels.data]);

  const params: TaskListParams = {
    projectId: project.id,
    state: f.state,
    sort: f.sort,
    limit: 50,
    ...(q ? { q } : {}),
    ...(f.assignee ? { assignee: f.assignee } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.labelId ? { labelId: f.labelId } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: [...qk.tasks, 'list', params],
    queryFn: ({ pageParam }) => tasksApi.list({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const tasks = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const filtered = JSON.stringify({ ...f, q }) !== JSON.stringify(INITIAL);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Search title or key, e.g. WEB-12" className="min-w-48 flex-1" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <Select aria-label="State" className="w-28" value={f.state} onChange={(e) => set('state', e.target.value as Filters['state'])}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </Select>
        <Select aria-label="Assignee" className="w-36" value={f.assignee} onChange={(e) => set('assignee', e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Priority" className="w-32" value={f.priority} onChange={(e) => set('priority', e.target.value as Filters['priority'])}>
          <option value="">Any priority</option>
          {[...TASK_PRIORITIES].reverse().map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </Select>
        {!!labels.data?.length && (
          <Select aria-label="Label" className="w-32" value={f.labelId} onChange={(e) => set('labelId', e.target.value)}>
            <option value="">Any label</option>
            {labels.data.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
        <Select aria-label="Sort" className="w-44" value={f.sort} onChange={(e) => set('sort', e.target.value as Filters['sort'])}>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="priority">Priority</option>
        </Select>
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNote>{errorMessage(list.error)}</ErrorNote>
      ) : tasks.length === 0 ? (
        filtered ? (
          <EmptyState title="No tasks match these filters" action={<Button onClick={() => setF(INITIAL)}>Clear filters</Button>} />
        ) : (
          <EmptyState title="No open tasks" description="Add tasks from the Board view" />
        )
      ) : (
        <>
          <TaskRows
            tasks={tasks}
            statusOf={(t) => statusById.get(t.statusId)}
            labelsOf={(t) => t.labelIds.flatMap((id) => labelById.get(id) ?? [])}
            onOpen={(t) => onOpen(t.id)}
          />
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
