import type { Types } from 'mongoose';
import type { AuthContext } from '../../auth/context';
import type { IUser } from '../../models/User';
import type { EntityInfo } from '../../services/entityAccess';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { userRepository } from '../../repositories/userRepository';
import { canSeeProject } from '../projects/projects.service';

/** Upper bound on the people considered for mentions; matches the project member list limit. */
const AUDIENCE_LIMIT = 500;

export type Audience = Map<string, IUser>;

/**
 * Active users who can see an entity: for project entities, members plus everyone the project is visible
 * to (admins, and non-guests when it is workspace-visible); otherwise the entity's participants and the
 * caller. Used to validate mentions and to filter who gets notified.
 */
export async function audienceOf(ctx: AuthContext, info: EntityInfo): Promise<Audience> {
  if (info.projectId) {
    const [project, members, users] = await Promise.all([
      projectRepository.findById(ctx.workspaceId, info.projectId),
      memberRepository.listForProject(ctx.workspaceId, info.projectId),
      userRepository.listActive(ctx.workspaceId, AUDIENCE_LIMIT),
    ]);
    if (!project) return new Map();
    const memberIds = new Set(members.map((m) => m.userId.toHexString()));
    return new Map(users.filter((u) => memberIds.has(u._id.toHexString()) || canSeeProject(project, u)).map((u) => [u._id.toHexString(), u]));
  }
  const ids = new Map<string, Types.ObjectId>([[ctx.userId.toHexString(), ctx.userId]]);
  for (const p of info.participants) ids.set(p.toHexString(), p);
  const users = await userRepository.findByIds(ctx.workspaceId, [...ids.values()]);
  return new Map(users.filter((u) => u.status === 'active').map((u) => [u._id.toHexString(), u]));
}
