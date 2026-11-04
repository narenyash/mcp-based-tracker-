import type { Types } from 'mongoose';
import { hasRoleAtLeast } from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';

/**
 * The project-visibility rule used by task lists, applied to cross-project reads: admins see every
 * project, others see their member projects plus workspace-visible ones, guests only member projects.
 */
export interface Visibility {
  /** null = unrestricted (admins). */
  projectIds: Types.ObjectId[] | null;
  /** For queries on projects themselves; null = unrestricted. */
  restrictTo: { memberOf: Types.ObjectId[]; includeWorkspaceVisible: boolean } | null;
}

export async function visibilityOf(ctx: AuthContext): Promise<Visibility> {
  if (hasRoleAtLeast(ctx.role, 'admin')) return { projectIds: null, restrictTo: null };
  const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
  const restrictTo = { memberOf: memberships.map((m) => m.projectId), includeWorkspaceVisible: ctx.role !== 'guest' };
  return { projectIds: await projectRepository.visibleIds(ctx.workspaceId, restrictTo), restrictTo };
}

/** Narrows a visibility to one project the caller is already known to see. */
export function onlyProject(v: Visibility, projectId: Types.ObjectId | undefined): Types.ObjectId[] | null {
  if (!projectId) return v.projectIds;
  return v.projectIds && !v.projectIds.some((id) => id.equals(projectId)) ? [] : [projectId];
}
