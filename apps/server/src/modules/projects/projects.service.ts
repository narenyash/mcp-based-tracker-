import { Types } from 'mongoose';
import {
  ERROR_CODES,
  hasRoleAtLeast,
  type CreateProjectInput,
  type Page,
  type AssignableUserDto,
  type ProjectDto,
  type ProjectMemberDto,
  type ProjectRole,
  type ProjectStatus,
  type Role,
  type UpdateProjectInput,
} from '@teamtrack/shared';
import { withTransaction } from '../../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError';
import type { AuthContext } from '../../auth/context';
import { DEFAULT_TASK_STATUSES, DEFAULT_TICKET_STATUSES, type IProject } from '../../models/Project';
import type { IProjectMember } from '../../models/ProjectMember';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { taskRepository } from '../../repositories/taskRepository';
import { evictFromProject } from '../../services/realtime';
import { toProjectDto } from '../dto';

interface Access {
  project: IProject;
  membership: IProjectMember | null;
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
}

/** Central project authorization. Non-visible projects return 404 (not 403) so existence is not leaked. */
async function access(ctx: AuthContext, projectId: string | Types.ObjectId): Promise<Access> {
  const project = await projectRepository.findById(ctx.workspaceId, projectId);
  if (!project) throw new NotFoundError('Project');
  const membership = await memberRepository.find(ctx.workspaceId, project._id, ctx.userId);
  const isAdmin = hasRoleAtLeast(ctx.role, 'admin');
  const canView = isAdmin || !!membership || (project.visibility === 'workspace' && ctx.role !== 'guest');
  if (!canView) throw new NotFoundError('Project');
  const canManage = isAdmin || membership?.role === 'lead';
  const canEdit = canManage || membership?.role === 'member';
  return { project, membership, canView, canEdit, canManage };
}

/** Whether a user can see a project without being a member (admins, or anyone but guests for workspace projects). */
export function canSeeProject(project: Pick<IProject, 'visibility'>, user: { role: Role }): boolean {
  return hasRoleAtLeast(user.role, 'admin') || (project.visibility === 'workspace' && user.role !== 'guest');
}

/**
 * Who a guest may see in people lists: themselves and anyone sharing a project with them.
 * null = no restriction (everyone but guests sees the whole workspace directory).
 */
export async function peerIdsOf(ctx: AuthContext): Promise<Types.ObjectId[] | null> {
  if (ctx.role !== 'guest') return null;
  const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
  const projectIds = await projectRepository.visibleIds(ctx.workspaceId, { memberOf: memberships.map((m) => m.projectId), includeWorkspaceVisible: false });
  const ids = new Map([[ctx.userId.toHexString(), ctx.userId]]);
  for (const id of await memberRepository.userIdsInProjects(ctx.workspaceId, projectIds)) ids.set(id.toHexString(), id);
  return [...ids.values()];
}

function assertManage(a: Access): void {
  if (!a.canManage) throw new ForbiddenError('Only project leads and admins can do this');
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const projectsService = {
  access,

  async list(ctx: AuthContext, q: { status: ProjectStatus; limit: number; cursor?: string | undefined }): Promise<Page<ProjectDto>> {
    const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
    const roleByProject = new Map(memberships.map((m) => [m.projectId.toHexString(), m.role]));
    const isAdmin = hasRoleAtLeast(ctx.role, 'admin');
    const page = await projectRepository.list(ctx.workspaceId, {
      ...q,
      // Admins see all; members also see workspace-visible projects; guests only their own.
      ...(isAdmin
        ? {}
        : { restrictTo: { memberOf: memberships.map((m) => m.projectId), includeWorkspaceVisible: ctx.role !== 'guest' } }),
    });
    const items = page.items.map((p) => toProjectDto(p, roleByProject.get(p._id.toHexString()) ?? null));
    return { items, nextCursor: page.nextCursor };
  },

  async get(ctx: AuthContext, id: string): Promise<ProjectDto> {
    const a = await access(ctx, id);
    return toProjectDto(a.project, a.membership?.role ?? null);
  },

  async create(ctx: AuthContext, input: CreateProjectInput): Promise<ProjectDto> {
    if (!hasRoleAtLeast(ctx.role, 'manager')) throw new ForbiddenError('Only managers and admins can create projects');
    try {
      return await withTransaction(async (session) => {
        const project = await projectRepository.create(
          {
            ...input,
            workspaceId: ctx.workspaceId,
            leadId: ctx.userId,
            memberCount: 1,
            workflow: { taskStatuses: DEFAULT_TASK_STATUSES, ticketStatuses: DEFAULT_TICKET_STATUSES },
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          } as Partial<IProject>,
          session,
        );
        await memberRepository.add(
          { workspaceId: ctx.workspaceId, projectId: project._id, userId: ctx.userId, role: 'lead', createdBy: ctx.userId },
          session,
        );
        return toProjectDto(project, 'lead');
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError(`Project key ${input.key} is already in use`, ERROR_CODES.CONFLICT, { field: 'key' });
      throw err;
    }
  },

  async update(ctx: AuthContext, id: string, input: UpdateProjectInput, expectedVersion: number): Promise<ProjectDto> {
    const a = await access(ctx, id);
    assertManage(a);
    const { leadId, ...rest } = input;
    // Drop keys the client did not send so they are not $set to undefined.
    const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<IProject>;
    if (leadId) {
      const leadMembership = await memberRepository.find(ctx.workspaceId, a.project._id, new Types.ObjectId(leadId));
      if (!leadMembership) throw new ValidationError([{ path: 'leadId', message: 'The new lead must be a project member' }]);
      set.leadId = new Types.ObjectId(leadId);
    }
    const updated = await projectRepository.update(ctx.workspaceId, a.project._id, expectedVersion, set, ctx.userId);
    if (a.project.visibility !== 'private' && updated.visibility === 'private') {
      // Non-members watching it live lose the stream now, not when their socket next reconnects.
      void evictFromProject(ctx.workspaceId.toHexString(), a.project._id.toHexString());
    }
    return toProjectDto(updated, a.membership?.role ?? null);
  },

  async remove(ctx: AuthContext, id: string): Promise<void> {
    if (!hasRoleAtLeast(ctx.role, 'admin')) throw new ForbiddenError('Only admins can delete projects');
    const a = await access(ctx, id);
    // Later phases' cascades (tickets, boards) join this transaction.
    await withTransaction(async (session) => {
      await projectRepository.softDelete(ctx.workspaceId, a.project._id, ctx.userId, session);
      await taskRepository.softDeleteByProject(ctx.workspaceId, a.project._id, ctx.userId, session);
    });
    void evictFromProject(ctx.workspaceId.toHexString(), a.project._id.toHexString());
  },

  /**
   * People the caller can assign work to in this project: leads and members, plus (for leads/admins)
   * anyone who can see the project and would be added on assignment. The caller is always included
   * when eligible, so "assign to me" works. Mirrors checkEligible in tasks.service.
   */
  async assignable(ctx: AuthContext, id: string): Promise<AssignableUserDto[]> {
    const a = await access(ctx, id);
    const [members, users] = await Promise.all([
      memberRepository.listForProject(ctx.workspaceId, a.project._id),
      userRepository.listActive(ctx.workspaceId, 500),
    ]);
    const roleOf = new Map(members.map((m) => [m.userId.toHexString(), m.role]));
    return users.flatMap((u) => {
      const role = roleOf.get(u._id.toHexString());
      const eligible = role ? role !== 'viewer' : (a.canManage || u._id.equals(ctx.userId)) && canSeeProject(a.project, u);
      return eligible ? [{ userId: u._id.toHexString(), name: u.name, email: u.email, isMember: !!role }] : [];
    });
  },

  async listMembers(ctx: AuthContext, id: string): Promise<ProjectMemberDto[]> {
    const a = await access(ctx, id);
    const members = await memberRepository.listForProject(ctx.workspaceId, a.project._id);
    const users = await userRepository.findByIds(ctx.workspaceId, members.map((m) => m.userId));
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    return members.flatMap((m) => {
      const u = byId.get(m.userId.toHexString());
      if (!u) return [];
      return [{ userId: u._id.toHexString(), name: u.name, email: u.email, avatarUrl: null, role: m.role, addedAt: m.createdAt.toISOString() }];
    });
  },

  async addMember(ctx: AuthContext, id: string, userId: string, role: ProjectRole): Promise<void> {
    const a = await access(ctx, id);
    assertManage(a);
    const user = await userRepository.findById(ctx.workspaceId, userId);
    if (!user || user.status !== 'active') throw new ValidationError([{ path: 'userId', message: 'User is not an active workspace member' }]);
    if (user.role === 'guest' && role === 'lead') throw new ValidationError([{ path: 'role', message: 'Guests cannot lead a project' }]);
    try {
      await withTransaction(async (session) => {
        await memberRepository.add({ workspaceId: ctx.workspaceId, projectId: a.project._id, userId: user._id, role, createdBy: ctx.userId }, session);
        await projectRepository.incrementMemberCount(ctx.workspaceId, a.project._id, 1, session);
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw new ConflictError('User is already a member of this project');
      throw err;
    }
  },

  async updateMember(ctx: AuthContext, id: string, userId: string, role: ProjectRole): Promise<void> {
    const a = await access(ctx, id);
    assertManage(a);
    const uid = new Types.ObjectId(userId);
    if (role === 'lead') {
      const user = await userRepository.findById(ctx.workspaceId, uid);
      if (user?.role === 'guest') throw new ValidationError([{ path: 'role', message: 'Guests cannot lead a project' }]);
    }
    await withTransaction(async (session) => {
      const current = await memberRepository.find(ctx.workspaceId, a.project._id, uid, session);
      if (!current) throw new NotFoundError('Member');
      if (current.role === 'lead' && role !== 'lead' && (await memberRepository.countLeads(ctx.workspaceId, a.project._id, session)) <= 1) {
        throw new ConflictError('A project needs at least one lead');
      }
      await memberRepository.setRole(ctx.workspaceId, a.project._id, uid, role, ctx.userId, session);
    });
  },

  async removeMember(ctx: AuthContext, id: string, userId: string): Promise<void> {
    const a = await access(ctx, id);
    const uid = new Types.ObjectId(userId);
    const isSelf = uid.equals(ctx.userId);
    if (!isSelf) assertManage(a);
    await withTransaction(async (session) => {
      const current = await memberRepository.find(ctx.workspaceId, a.project._id, uid, session);
      if (!current) throw new NotFoundError('Member');
      if (current.role === 'lead' && (await memberRepository.countLeads(ctx.workspaceId, a.project._id, session)) <= 1) {
        throw new ConflictError('A project needs at least one lead');
      }
      await memberRepository.remove(ctx.workspaceId, a.project._id, uid, session);
      await projectRepository.incrementMemberCount(ctx.workspaceId, a.project._id, -1, session);
    });
    void evictFromProject(ctx.workspaceId.toHexString(), a.project._id.toHexString(), [userId]);
  },
};
