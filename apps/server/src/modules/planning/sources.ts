import type { Types } from 'mongoose';
import { taskKeySchema, type CalendarItemDto, type SearchHitDto } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import type { CalendarRange } from '../../services/discovery';
import { discoveryRepository, type ProjectRef, type TaskRef } from './planning.repository';
import { onlyProject, visibilityOf } from './visibility';
import { peerIdsOf } from '../projects/projects.service';
import { dateToKey } from './time';

/* Search and calendar sources for core data: tasks, projects and people (registered in register.ts). */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Patterns are built from at most this many characters of the query (the API caps it at 80 anyway). */
const MAX_PATTERN = 80;
const contains = (q: string) => new RegExp(escapeRegex(q.slice(0, MAX_PATTERN)), 'i');
const prefix = (q: string) => new RegExp(`^${escapeRegex(q.slice(0, MAX_PATTERN))}`, 'i');
const FALLBACK_COLOR = '#a3a3a3';

export const taskPath = (t: Pick<TaskRef, '_id' | 'projectId'>) => `/projects/${t.projectId.toHexString()}?task=${t._id.toHexString()}`;

async function projectsOf(ctx: AuthContext, tasks: Pick<TaskRef, 'projectId'>[]): Promise<Map<string, ProjectRef>> {
  const ids = new Map(tasks.map((t) => [t.projectId.toHexString(), t.projectId]));
  const projects = await discoveryRepository.projectsByIds(ctx.workspaceId, [...ids.values()]);
  return new Map(projects.map((p) => [p._id.toHexString(), p]));
}

const statusOf = (p: ProjectRef | undefined, statusId: string) => p?.workflow.taskStatuses.find((s) => s.id === statusId);

function isVisible(projectIds: Types.ObjectId[] | null, projectId: Types.ObjectId): boolean {
  return !projectIds || projectIds.some((id) => id.equals(projectId));
}

/** An exact key ("WEB-12") comes first; then title matches, most recently updated first. */
export async function searchTasks(ctx: AuthContext, q: string, limit: number): Promise<SearchHitDto[]> {
  const { projectIds } = await visibilityOf(ctx);
  if (projectIds?.length === 0) return [];

  const found: TaskRef[] = [];
  if (taskKeySchema.safeParse(q).success) {
    const [projectKey, num] = q.toUpperCase().split('-') as [string, string];
    const exact = await discoveryRepository.taskByKey(ctx.workspaceId, projectKey, Number(num));
    if (exact && isVisible(projectIds, exact.projectId)) found.push(exact);
  }
  const byTitle = await discoveryRepository.tasksByTitle(ctx.workspaceId, contains(q), projectIds, limit);
  for (const t of byTitle) if (found.length < limit && !found.some((f) => f._id.equals(t._id))) found.push(t);

  const projects = await projectsOf(ctx, found);
  return found.map((t) => {
    const p = projects.get(t.projectId.toHexString());
    return {
      type: 'task',
      id: t._id.toHexString(),
      title: `${t.key} ${t.title}`,
      subtitle: [p?.name, statusOf(p, t.statusId)?.name].filter(Boolean).join(' · '),
      path: taskPath(t),
    };
  });
}

export async function searchProjects(ctx: AuthContext, q: string, limit: number): Promise<SearchHitDto[]> {
  const { restrictTo } = await visibilityOf(ctx);
  const projects = await discoveryRepository.searchProjects(ctx.workspaceId, contains(q), prefix(q), restrictTo, limit);
  return projects.map((p) => ({
    type: 'project',
    id: p._id.toHexString(),
    title: p.name,
    subtitle: p.status === 'archived' ? `${p.key} · Archived` : p.key,
    path: `/projects/${p._id.toHexString()}`,
  }));
}

/** Guests only find people who share a project with them. */
export async function searchUsers(ctx: AuthContext, q: string, limit: number): Promise<SearchHitDto[]> {
  const users = await discoveryRepository.searchUsers(ctx.workspaceId, prefix(q), await peerIdsOf(ctx), limit);
  return users.map((u) => ({ type: 'user', id: u._id.toHexString(), title: u.name, subtitle: u.email, path: '/team' }));
}

/** Tasks due in the range, coloured by their workflow status. */
export async function calendarTasks(ctx: AuthContext, range: CalendarRange): Promise<CalendarItemDto[]> {
  const projectIds = onlyProject(await visibilityOf(ctx), range.projectId);
  if (projectIds?.length === 0) return [];
  const tasks = await discoveryRepository.tasksDueBetween(ctx.workspaceId, range.from, range.to, { projectIds, assigneeId: range.userId });
  const projects = await projectsOf(ctx, tasks);
  return tasks.map((t) => {
    const p = projects.get(t.projectId.toHexString());
    return {
      type: 'task',
      id: t._id.toHexString(),
      key: t.key,
      title: t.title,
      date: dateToKey(t.dueDate!),
      path: taskPath(t),
      color: statusOf(p, t.statusId)?.color ?? p?.color ?? FALLBACK_COLOR,
      done: t.statusCategory === 'done',
    };
  });
}
