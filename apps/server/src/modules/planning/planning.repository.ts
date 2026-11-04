import type { ClientSession, FilterQuery, Types } from 'mongoose';
import type { Page } from '@teamtrack/shared';
import { Project, type IProject } from '../../models/Project';
import { Standup, type IStandup } from '../../models/Standup';
import { Task, type ITask } from '../../models/Task';
import { User, type IUser } from '../../models/User';
import { CI_COLLATION } from '../../db/schema';
import { paginate } from '../../db/pagination';
import { updateVersioned } from '../../db/versioned';

/*
 * Read paths for search, the calendar and standup suggestions (narrow projections, hard limits and a
 * time budget, because they run on every keystroke), plus the standups collection itself.
 * `projectIds: null` means unrestricted (admins); otherwise only tasks/projects in that list.
 */

/** Upper bound for one search or calendar query; a slow regex scan is cut off rather than piling up. */
const MAX_TIME_MS = 1_000;
/** Calendar items one source returns for one range; a month of due dates is far below this. */
const CALENDAR_CAP = 2_000;

export type TaskRef = Pick<ITask, '_id' | 'projectId' | 'key' | 'title' | 'statusId' | 'statusCategory'>;
export type DueTask = TaskRef & Pick<ITask, 'dueDate'>;
export type ProjectRef = Pick<IProject, '_id' | 'key' | 'name' | 'color' | 'status' | 'visibility' | 'workflow'>;
export type UserRef = Pick<IUser, '_id' | 'name' | 'email' | 'role' | 'status'>;

const TASK_REF = { _id: 1, projectId: 1, key: 1, title: 1, statusId: 1, statusCategory: 1 } as const;
const PROJECT_REF = { _id: 1, key: 1, name: 1, color: 1, status: 1, visibility: 1, workflow: 1 } as const;
const USER_REF = { _id: 1, name: 1, email: 1, role: 1, status: 1 } as const;

function inProjects(filter: FilterQuery<ITask>, projectIds: Types.ObjectId[] | null): FilterQuery<ITask> {
  return projectIds ? { ...filter, projectId: { $in: projectIds } } : filter;
}

export const discoveryRepository = {
  /** Exact key lookup through the unique (project key, number) indexes. */
  async taskByKey(workspaceId: Types.ObjectId, projectKey: string, number: number): Promise<TaskRef | null> {
    const project = await Project.findOne({ workspaceId, key: projectKey }, { _id: 1 }).collation(CI_COLLATION).lean<{ _id: Types.ObjectId }>();
    if (!project) return null;
    return Task.findOne({ workspaceId, projectId: project._id, number }, TASK_REF).lean<TaskRef>();
  },

  tasksByTitle(workspaceId: Types.ObjectId, rx: RegExp, projectIds: Types.ObjectId[] | null, limit: number) {
    return Task.find(inProjects({ workspaceId, title: rx }, projectIds), TASK_REF)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(MAX_TIME_MS)
      .lean<TaskRef[]>();
  },

  tasksByIds(workspaceId: Types.ObjectId, ids: Types.ObjectId[], projectIds: Types.ObjectId[] | null) {
    if (!ids.length) return Promise.resolve([] as TaskRef[]);
    return Task.find(inProjects({ workspaceId, _id: { $in: ids } }, projectIds), TASK_REF).lean<TaskRef[]>();
  },

  tasksDueBetween(workspaceId: Types.ObjectId, from: Date, to: Date, opts: { projectIds: Types.ObjectId[] | null; assigneeId?: Types.ObjectId | undefined }) {
    const filter: FilterQuery<ITask> = { workspaceId, dueDate: { $gte: from, $lte: to } };
    if (opts.assigneeId) filter.assigneeId = opts.assigneeId;
    return Task.find(inProjects(filter, opts.projectIds), { ...TASK_REF, dueDate: 1 })
      .sort({ dueDate: 1, _id: 1 })
      .limit(CALENDAR_CAP)
      .maxTimeMS(MAX_TIME_MS * 3)
      .lean<DueTask[]>();
  },

  /** Tasks an assignee finished in [since, until). */
  completedBetween(workspaceId: Types.ObjectId, assigneeId: Types.ObjectId, since: Date, until: Date, projectIds: Types.ObjectId[] | null, limit: number) {
    return Task.find(inProjects({ workspaceId, assigneeId, statusCategory: 'done', completedAt: { $gte: since, $lt: until } }, projectIds), TASK_REF)
      .sort({ completedAt: -1, _id: -1 })
      .limit(limit)
      .lean<TaskRef[]>();
  },

  inProgressFor(workspaceId: Types.ObjectId, assigneeId: Types.ObjectId, projectIds: Types.ObjectId[] | null, limit: number) {
    return Task.find(inProjects({ workspaceId, assigneeId, statusCategory: 'in_progress' }, projectIds), TASK_REF)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean<TaskRef[]>();
  },

  projectsByIds(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
    if (!ids.length) return Promise.resolve([] as ProjectRef[]);
    return Project.find({ workspaceId, _id: { $in: ids } }, PROJECT_REF).lean<ProjectRef[]>();
  },

  /** Projects by name (substring) or key (prefix), restricted like project lists. */
  searchProjects(
    workspaceId: Types.ObjectId,
    nameRx: RegExp,
    keyRx: RegExp,
    restrictTo: { memberOf: Types.ObjectId[]; includeWorkspaceVisible: boolean } | null,
    limit: number,
  ) {
    const filter: FilterQuery<IProject> = { workspaceId, $or: [{ name: nameRx }, { key: keyRx }] };
    if (restrictTo) {
      const member = { _id: { $in: restrictTo.memberOf } };
      filter.$and = [restrictTo.includeWorkspaceVisible ? { $or: [{ visibility: 'workspace' }, member] } : member];
    }
    return Project.find(filter, PROJECT_REF).collation(CI_COLLATION).sort({ status: 1, name: 1 }).limit(limit).maxTimeMS(MAX_TIME_MS).lean<ProjectRef[]>();
  },

  /** Active people whose name or email starts with the (escaped) prefix. */
  /** `ids` narrows the search to those people (null = the whole workspace). */
  searchUsers(workspaceId: Types.ObjectId, prefixRx: RegExp, ids: Types.ObjectId[] | null, limit: number) {
    const filter: FilterQuery<IUser> = { workspaceId, status: 'active', $or: [{ name: prefixRx }, { email: prefixRx }] };
    if (ids) filter._id = { $in: ids };
    return User.find(filter, USER_REF)
      .collation(CI_COLLATION)
      .sort({ name: 1 })
      .limit(limit)
      .maxTimeMS(MAX_TIME_MS)
      .lean<UserRef[]>();
  },

  /** Workspace roster for the standup feed (active people only), optionally limited to some users. */
  activeUsers(workspaceId: Types.ObjectId, opts: { ids?: Types.ObjectId[] | undefined; limit: number }) {
    const filter: FilterQuery<IUser> = { workspaceId, status: 'active' };
    if (opts.ids) filter._id = { $in: opts.ids };
    return User.find(filter, USER_REF).collation(CI_COLLATION).sort({ name: 1 }).limit(opts.limit).lean<UserRef[]>();
  },

  usersByIds(workspaceId: Types.ObjectId, ids: Types.ObjectId[]) {
    if (!ids.length) return Promise.resolve([] as UserRef[]);
    return User.find({ workspaceId, _id: { $in: ids } }, USER_REF).lean<UserRef[]>();
  },
};

export const standupRepository = {
  find(workspaceId: Types.ObjectId, userId: Types.ObjectId, dateKey: string, session?: ClientSession) {
    return Standup.findOne({ workspaceId, userId, dateKey }).session(session ?? null).lean<IStandup>();
  },

  /** Throws a duplicate-key error (11000) if this person already has an entry for the day. */
  async create(doc: Omit<IStandup, '_id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<IStandup> {
    return (await Standup.create(doc)).toObject<IStandup>();
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, set: Partial<IStandup>) {
    return updateVersioned(Standup, { workspaceId, _id: id }, expectedVersion, { $set: set }, 'Standup');
  },

  /** A day's entries, optionally only by some people. */
  forDay(workspaceId: Types.ObjectId, dateKey: string, userIds: Types.ObjectId[] | null, limit: number) {
    const filter: FilterQuery<IStandup> = { workspaceId, dateKey };
    if (userIds) filter.userId = { $in: userIds };
    return Standup.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit).lean<IStandup[]>();
  },

  history(workspaceId: Types.ObjectId, userId: Types.ObjectId, limit: number, cursor?: string): Promise<Page<IStandup>> {
    return paginate(Standup, { filter: { workspaceId, userId }, sortField: 'dateKey', direction: -1, limit, cursor });
  },
};
