import { Types } from 'mongoose';
import type {
  Page,
  PersonRef,
  StandupDto,
  StandupFeedDto,
  StandupFeedQuery,
  StandupHistoryQuery,
  StandupSuggestionsDto,
  StandupTaskRefDto,
  UpsertStandupInput,
} from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { NotFoundError, PreconditionRequiredError, StaleVersionError, ValidationError } from '../../errors/AppError';
import type { IStandup } from '../../models/Standup';
import type { IWorkspace } from '../../models/Workspace';
import { memberRepository } from '../../repositories/projectRepository';
import { workspaceRepository } from '../../repositories/workspaceRepository';
import { peerIdsOf, projectsService } from '../projects/projects.service';
import { discoveryRepository, standupRepository, type TaskRef } from './planning.repository';
import { visibilityOf, type Visibility } from './visibility';
import { addDays, hhmmToMinutes, isWorkingDay, keyToDate, localNow, previousWorkingDay, startOfLocalDay, type LocalNow } from './time';

/** Feed size bounds: a workspace roster and one day's entries. */
const ROSTER_LIMIT = 500;
const SUGGESTION_LIMIT = 20;

const oid = (id: string) => new Types.ObjectId(id);
const isDuplicateKey = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
const uniqueIds = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))].map(oid);
const sameIds = (a: Types.ObjectId[], b: Types.ObjectId[]) => a.length === b.length && a.every((id, i) => id.equals(b[i]!));

interface Clock {
  ws: IWorkspace;
  now: LocalNow;
  today: string;
  yesterday: string;
}

async function clockOf(ctx: AuthContext): Promise<Clock> {
  const ws = await workspaceRepository.findById(ctx.workspaceId);
  if (!ws) throw new NotFoundError('Workspace');
  const now = localNow(ws.timezone);
  return { ws, now, today: now.dateKey, yesterday: addDays(now.dateKey, -1) };
}

const toTaskRef = (t: TaskRef): StandupTaskRefDto => ({ id: t._id.toHexString(), key: t.key, title: t.title, projectId: t.projectId.toHexString() });

/**
 * An entry tagged with a project the viewer can't see keeps only who posted and their mood:
 * the project and the free text (which is about that project) are hidden.
 */
function redact(dto: StandupDto): StandupDto {
  return { ...dto, projectId: null, yesterday: '', today: '', blockers: '', blockerTasks: [] };
}

function toStandupDto(s: IStandup, people: Map<string, PersonRef>, tasks: Map<string, TaskRef>): StandupDto {
  const uid = s.userId.toHexString();
  return {
    id: s._id.toHexString(),
    date: s.dateKey,
    user: people.get(uid) ?? { id: uid, name: 'Removed user' },
    projectId: s.projectId?.toHexString() ?? null,
    yesterday: s.yesterday,
    today: s.today,
    blockers: s.blockers,
    blockerTasks: s.blockerTaskIds.flatMap((id) => {
      const t = tasks.get(id.toHexString());
      return t ? [toTaskRef(t)] : [];
    }),
    mood: s.mood,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    version: s.version,
  };
}

/** Resolves names and the blocking tasks the viewer may see, in two queries for any number of entries. */
async function toDtos(ctx: AuthContext, entries: IStandup[], vis?: Visibility): Promise<StandupDto[]> {
  if (!entries.length) return [];
  const { projectIds } = vis ?? (await visibilityOf(ctx));
  const userIds = new Map(entries.map((s) => [s.userId.toHexString(), s.userId]));
  const taskIds = new Map(entries.flatMap((s) => s.blockerTaskIds).map((id) => [id.toHexString(), id]));
  const [users, tasks] = await Promise.all([
    discoveryRepository.usersByIds(ctx.workspaceId, [...userIds.values()]),
    taskIds.size ? discoveryRepository.tasksByIds(ctx.workspaceId, [...taskIds.values()], projectIds) : [],
  ]);
  const people = new Map(users.map((u) => [u._id.toHexString(), { id: u._id.toHexString(), name: u.name }]));
  const taskMap = new Map(tasks.map((t) => [t._id.toHexString(), t]));
  // Your own entries are always shown in full.
  const hidden = (s: IStandup) => !!projectIds && !!s.projectId && !s.userId.equals(ctx.userId) && !projectIds.some((id) => id.equals(s.projectId!));
  return entries.map((s) => (hidden(s) ? redact(toStandupDto(s, people, taskMap)) : toStandupDto(s, people, taskMap)));
}

async function assertBlockers(ctx: AuthContext, ids: Types.ObjectId[]): Promise<void> {
  if (!ids.length) return;
  const found = await discoveryRepository.tasksByIds(ctx.workspaceId, ids, (await visibilityOf(ctx)).projectIds);
  if (found.length !== ids.length) throw new ValidationError([{ path: 'blockerTaskIds', message: 'One or more blocking tasks were not found' }]);
}

async function resolveProject(ctx: AuthContext, projectId: string | null | undefined): Promise<Types.ObjectId | null | undefined> {
  if (projectId === undefined || projectId === null) return projectId;
  try {
    return (await projectsService.access(ctx, projectId)).project._id;
  } catch (err) {
    if (err instanceof NotFoundError) throw new ValidationError([{ path: 'projectId', message: 'Project not found' }]);
    throw err;
  }
}

/**
 * Whose standups the caller sees on the feed. `entryUserIds: null` = everyone in the workspace.
 * A project narrows it to its members; guests only see people who share a project with them.
 */
async function audience(ctx: AuthContext, projectId: string | undefined): Promise<Types.ObjectId[] | null> {
  if (projectId) {
    const a = await projectsService.access(ctx, projectId);
    return (await memberRepository.listForProject(ctx.workspaceId, a.project._id)).map((m) => m.userId);
  }
  return peerIdsOf(ctx);
}

export const standupsService = {
  /**
   * Creates or updates the caller's standup for today (or yesterday). Creating needs no version;
   * updating needs If-Match (428 without, 409 if stale). Re-sending unchanged content is a no-op.
   */
  async upsertMine(ctx: AuthContext, input: UpsertStandupInput, expectedVersion: number | undefined): Promise<{ standup: StandupDto; created: boolean }> {
    const clock = await clockOf(ctx);
    const dateKey = input.date ?? clock.today;
    if (dateKey !== clock.today && dateKey !== clock.yesterday) {
      throw new ValidationError([{ path: 'date', message: 'You can only write your standup for today or yesterday' }]);
    }
    const blockerTaskIds = uniqueIds(input.blockerTaskIds);
    const [projectId] = await Promise.all([resolveProject(ctx, input.projectId), assertBlockers(ctx, blockerTaskIds)]);
    const content = { yesterday: input.yesterday, today: input.today, blockers: input.blockers, blockerTaskIds, mood: input.mood };

    const existing = await standupRepository.find(ctx.workspaceId, ctx.userId, dateKey);
    if (existing) {
      if (expectedVersion === undefined) throw new PreconditionRequiredError();
      if (existing.version !== expectedVersion) throw new StaleVersionError();
      const set: Partial<IStandup> = { ...content, ...(projectId !== undefined ? { projectId } : {}) };
      const unchanged =
        set.yesterday === existing.yesterday &&
        set.today === existing.today &&
        set.blockers === existing.blockers &&
        set.mood === existing.mood &&
        sameIds(blockerTaskIds, existing.blockerTaskIds) &&
        (projectId === undefined || String(projectId) === String(existing.projectId));
      const doc = unchanged ? existing : await standupRepository.update(ctx.workspaceId, existing._id, expectedVersion, { ...set, updatedBy: ctx.userId });
      return { standup: (await toDtos(ctx, [doc]))[0]!, created: false };
    }

    try {
      const doc = await standupRepository.create({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        projectId: projectId ?? null,
        dateKey,
        date: keyToDate(dateKey),
        ...content,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      return { standup: (await toDtos(ctx, [doc]))[0]!, created: true };
    } catch (err) {
      // Another tab or device created it first: the caller must reload and edit that one.
      if (isDuplicateKey(err)) throw new StaleVersionError();
      throw err;
    }
  },

  /** A day's team feed: everyone's entries (that the caller may see) and who hasn't posted yet. */
  async feed(ctx: AuthContext, q: StandupFeedQuery): Promise<StandupFeedDto> {
    const clock = await clockOf(ctx);
    const date = q.date ?? clock.today;
    const vis = await visibilityOf(ctx);
    const entryUserIds = await audience(ctx, q.projectId);

    const [entries, roster, mine, todays] = await Promise.all([
      standupRepository.forDay(ctx.workspaceId, date, entryUserIds, ROSTER_LIMIT),
      discoveryRepository.activeUsers(ctx.workspaceId, { ids: entryUserIds ?? undefined, limit: ROSTER_LIMIT }),
      standupRepository.find(ctx.workspaceId, ctx.userId, date),
      date === clock.today ? null : standupRepository.find(ctx.workspaceId, ctx.userId, clock.today),
    ]);
    const [dtos, mineDto] = await Promise.all([toDtos(ctx, entries, vis), mine ? toDtos(ctx, [mine], vis) : []]);

    const posted = new Set(entries.map((s) => s.userId.toHexString()));
    const postedToday = date === clock.today ? !!mine : !!todays;
    const { settings } = clock.ws;
    return {
      date,
      today: clock.today,
      editable: date === clock.today || date === clock.yesterday,
      standupTime: settings.standupTime,
      nudge: !postedToday && isWorkingDay(clock.now.weekday, settings.workWeek) && clock.now.minutes >= hhmmToMinutes(settings.standupTime),
      mine: mineDto[0] ?? null,
      entries: dtos,
      notPosted: roster.filter((u) => !posted.has(u._id.toHexString())).map((u) => ({ id: u._id.toHexString(), name: u.name })),
    };
  },

  async history(ctx: AuthContext, q: StandupHistoryQuery): Promise<Page<StandupDto>> {
    const page = await standupRepository.history(ctx.workspaceId, ctx.userId, q.limit, q.cursor);
    return { items: await toDtos(ctx, page.items), nextCursor: page.nextCursor };
  },

  /**
   * Prefill for the form: what I finished since the previous working day began (so Monday covers
   * Friday and the weekend) and what I'm working on now.
   */
  async suggestions(ctx: AuthContext): Promise<StandupSuggestionsDto> {
    const clock = await clockOf(ctx);
    const since = startOfLocalDay(previousWorkingDay(clock.today, clock.ws.settings.workWeek), clock.ws.timezone);
    const until = startOfLocalDay(clock.today, clock.ws.timezone);
    const { projectIds } = await visibilityOf(ctx);
    const [completed, inProgress] = await Promise.all([
      discoveryRepository.completedBetween(ctx.workspaceId, ctx.userId, since, until, projectIds, SUGGESTION_LIMIT),
      discoveryRepository.inProgressFor(ctx.workspaceId, ctx.userId, projectIds, SUGGESTION_LIMIT),
    ]);
    return { since: since.toISOString(), until: until.toISOString(), completed: completed.map(toTaskRef), inProgress: inProgress.map(toTaskRef) };
  },
};
