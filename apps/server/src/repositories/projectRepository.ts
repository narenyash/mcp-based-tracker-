import type { ClientSession, FilterQuery, Types } from 'mongoose';
import type { Page, ProjectRole, ProjectStatus } from '@teamtrack/shared';
import { Project, type IProject } from '../models/Project';
import { ProjectMember, type IProjectMember } from '../models/ProjectMember';
import { paginate } from '../db/pagination';
import { updateVersioned } from '../db/versioned';

export const projectRepository = {
  findById(workspaceId: Types.ObjectId, id: Types.ObjectId | string, session?: ClientSession) {
    return Project.findOne({ workspaceId, _id: id }).session(session ?? null).lean<IProject>();
  },

  async create(doc: Partial<IProject>, session: ClientSession): Promise<IProject> {
    const [created] = await Project.create([doc], { session });
    return created!.toObject<IProject>();
  },

  list(
    workspaceId: Types.ObjectId,
    opts: {
      status: ProjectStatus;
      limit: number;
      cursor?: string | undefined;
      /** Omit for unrestricted (admins). */
      restrictTo?: { memberOf: Types.ObjectId[]; includeWorkspaceVisible: boolean };
    },
  ): Promise<Page<IProject>> {
    const filter: FilterQuery<IProject> = { workspaceId, status: opts.status };
    if (opts.restrictTo) {
      const member = { _id: { $in: opts.restrictTo.memberOf } };
      if (opts.restrictTo.includeWorkspaceVisible) filter.$or = [{ visibility: 'workspace' }, member];
      else Object.assign(filter, member);
    }
    return paginate(Project, { filter, sortField: 'name', direction: 1, limit: opts.limit, cursor: opts.cursor });
  },

  /** Ids of projects visible through workspace visibility or membership (for non-admin cross-project queries). */
  visibleIds(workspaceId: Types.ObjectId, opts: { memberOf: Types.ObjectId[]; includeWorkspaceVisible: boolean }): Promise<Types.ObjectId[]> {
    const member = { _id: { $in: opts.memberOf } };
    const filter: FilterQuery<IProject> = opts.includeWorkspaceVisible ? { workspaceId, $or: [{ visibility: 'workspace' }, member] } : { workspaceId, ...member };
    return Project.distinct('_id', filter);
  },

  update(workspaceId: Types.ObjectId, id: Types.ObjectId, expectedVersion: number, set: Partial<IProject>, actorId: Types.ObjectId, session?: ClientSession) {
    return updateVersioned(Project, { workspaceId, _id: id }, expectedVersion, { $set: { ...set, updatedBy: actorId } }, 'Project', session);
  },

  async incrementMemberCount(workspaceId: Types.ObjectId, id: Types.ObjectId, by: number, session: ClientSession): Promise<void> {
    await Project.updateOne({ workspaceId, _id: id }, { $inc: { memberCount: by } }, { session });
  },

  async softDelete(workspaceId: Types.ObjectId, id: Types.ObjectId, actorId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await Project.updateOne(
      { workspaceId, _id: id },
      { $set: { deletedAt: new Date(), deletedBy: actorId }, $inc: { version: 1 } },
      { session },
    );
    return res.modifiedCount === 1;
  },
};

export const memberRepository = {
  find(workspaceId: Types.ObjectId, projectId: Types.ObjectId, userId: Types.ObjectId, session?: ClientSession) {
    return ProjectMember.findOne({ workspaceId, projectId, userId }).session(session ?? null).lean<IProjectMember>();
  },

  listForProject(workspaceId: Types.ObjectId, projectId: Types.ObjectId) {
    return ProjectMember.find({ workspaceId, projectId }).sort({ createdAt: 1 }).limit(500).lean<IProjectMember[]>();
  },

  listForUser(workspaceId: Types.ObjectId, userId: Types.ObjectId) {
    return ProjectMember.find({ workspaceId, userId }).lean<IProjectMember[]>();
  },

  /** Everyone who is a member of at least one of the projects. */
  userIdsInProjects(workspaceId: Types.ObjectId, projectIds: Types.ObjectId[]): Promise<Types.ObjectId[]> {
    if (!projectIds.length) return Promise.resolve([]);
    return ProjectMember.distinct('userId', { workspaceId, projectId: { $in: projectIds } });
  },

  async add(
    doc: { workspaceId: Types.ObjectId; projectId: Types.ObjectId; userId: Types.ObjectId; role: ProjectRole; createdBy: Types.ObjectId },
    session: ClientSession,
  ): Promise<IProjectMember> {
    const [created] = await ProjectMember.create([doc], { session });
    return created!.toObject<IProjectMember>();
  },

  setRole(workspaceId: Types.ObjectId, projectId: Types.ObjectId, userId: Types.ObjectId, role: ProjectRole, actorId: Types.ObjectId, session?: ClientSession) {
    return ProjectMember.findOneAndUpdate(
      { workspaceId, projectId, userId },
      { $set: { role, updatedBy: actorId }, $inc: { version: 1 } },
      { new: true, session: session ?? null },
    ).lean<IProjectMember>();
  },

  async remove(workspaceId: Types.ObjectId, projectId: Types.ObjectId, userId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const res = await ProjectMember.deleteOne({ workspaceId, projectId, userId }, { session });
    return res.deletedCount === 1;
  },

  countLeads(workspaceId: Types.ObjectId, projectId: Types.ObjectId, session: ClientSession) {
    return ProjectMember.countDocuments({ workspaceId, projectId, role: 'lead' }).session(session);
  },
};
