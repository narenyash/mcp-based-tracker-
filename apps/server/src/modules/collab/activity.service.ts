import type { ClientSession } from 'mongoose';
import type { ActivityDto, ListActivityQuery, Page } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { MAX_ACTIVITY_CHANGES, type IActivity } from '../../models/Activity';
import type { ActivityEntry } from '../../services/activity';
import { resolveEntity } from '../../services/entityAccess';
import { projectsService } from '../projects/projects.service';
import { loadPeople, toActivityDto } from './collab.dto';
import { activityRepository } from './repositories';

const clip = (s: string | null, max: number) => (s === null ? null : s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The activity sink installed by register.ts. Writes with the caller's session, so an entry commits or
 * rolls back with the change it describes. Values are clipped rather than rejected: a long title must
 * never make the business change fail.
 */
export async function writeActivity(session: ClientSession | null, entries: ActivityEntry[]): Promise<void> {
  const at = new Date();
  await activityRepository.insert(
    entries.map((e) => ({
      workspaceId: e.workspaceId,
      projectId: e.projectId,
      entityType: e.entityType,
      entityId: e.entityId,
      entityKey: clip(e.entityKey, 80) || '?',
      actorId: e.actorId,
      action: e.action,
      changes: (e.changes ?? []).slice(0, MAX_ACTIVITY_CHANGES).map((c) => ({ field: clip(c.field, 40)!, from: clip(c.from, 300), to: clip(c.to, 300) })),
      at,
    })),
    session,
  );
}

export const activityService = {
  /** One entity's history (anyone who can see it) or a project's feed (anyone who can see the project). Newest first. */
  async list(ctx: AuthContext, q: ListActivityQuery): Promise<Page<ActivityDto>> {
    let page: Page<IActivity>;
    if (q.projectId) {
      const a = await projectsService.access(ctx, q.projectId);
      page = await activityRepository.forProject(ctx.workspaceId, a.project._id, q.limit, q.cursor);
    } else {
      const info = await resolveEntity(ctx, q.entityType!, q.entityId!);
      page = await activityRepository.forEntity({ workspaceId: ctx.workspaceId, entityType: info.type, entityId: info.id }, q.limit, q.cursor);
    }
    const people = await loadPeople(ctx.workspaceId, page.items.map((a) => a.actorId));
    return { items: page.items.map((a) => toActivityDto(a, people)), nextCursor: page.nextCursor };
  },
};
