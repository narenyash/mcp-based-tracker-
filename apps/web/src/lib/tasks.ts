import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { BoardDto, ProjectDto, StatusCategory, TaskDto, WorkflowStatusDto } from '@teamtrack/shared';
import { labelsApi, projectsApi, tasksApi } from '../api/endpoints';

/** Query keys in one place so invalidation can't drift from the queries. */
export const qk = {
  board: (projectId: string) => ['board', projectId] as const,
  task: (id: string) => ['task', id] as const,
  tasks: ['tasks'] as const,
  labels: (projectId: string) => ['labels', projectId] as const,
  members: (projectId: string) => ['project', projectId, 'members'] as const,
  assignable: (projectId: string) => ['project', projectId, 'assignable'] as const,
  notifications: ['notifications'] as const,
  preferences: ['preferences'] as const,
};

/** "My work" lists, shared by the My work page and the dashboard so both read the same cache. */
export const myWorkQueries = {
  assigned: { queryKey: [...qk.tasks, 'mine', 'assigned'], queryFn: () => tasksApi.list({ assignee: 'me', state: 'open', sort: 'priority', limit: 100 }) },
  testing: { queryKey: [...qk.tasks, 'mine', 'testing'], queryFn: () => tasksApi.list({ tester: 'me', statusCategory: 'testing', sort: 'updated', limit: 100 }) },
};

/** Writes a fresh task from the server into every cache that shows it. */
export function syncTask(qc: QueryClient, task: TaskDto): void {
  qc.setQueryData(qk.task(task.id), task);
  qc.setQueryData<BoardDto>(qk.board(task.projectId), (b) => b && { ...b, tasks: b.tasks.map((t) => (t.id === task.id ? task : t)) });
  void qc.invalidateQueries({ queryKey: qk.tasks });
  if (task.parentTaskId) void qc.invalidateQueries({ queryKey: qk.task(task.parentTaskId) });
  // Assigning someone outside the project adds them to it.
  void qc.invalidateQueries({ queryKey: ['project', task.projectId] });
}

/** After creates and deletes, positions and counters change: refetch rather than patch. */
export function refreshProjectTasks(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: qk.board(projectId) });
  void qc.invalidateQueries({ queryKey: qk.tasks });
}

export function sortedStatuses(project: ProjectDto): WorkflowStatusDto[] {
  return [...project.workflow.taskStatuses].sort((a, b) => a.order - b.order);
}

export function firstStatusOf(project: ProjectDto, category: StatusCategory): WorkflowStatusDto | undefined {
  return sortedStatuses(project).find((s) => s.category === category);
}

/**
 * People the current user can give work to here (the server decides: members, plus people who would
 * join the project on assignment). `isMember: false` entries are labelled in pickers.
 */
export function useAssignablePeople(projectId: string) {
  const q = useQuery({ queryKey: qk.assignable(projectId), queryFn: () => projectsApi.assignable(projectId), staleTime: 60_000 });
  return { ...q, people: q.data ?? [] };
}

export function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

export function useLabels(projectId: string) {
  return useQuery({ queryKey: qk.labels(projectId), queryFn: () => labelsApi.list(projectId), staleTime: 60_000 });
}

export function isOverdue(t: Pick<TaskDto, 'dueDate' | 'statusCategory'>): boolean {
  if (!t.dueDate || t.statusCategory === 'done') return false;
  return t.dueDate < new Date().toISOString().slice(0, 10);
}

export function formatDue(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
