/**
 * Phase 4: tickets (bugs, issues, requests), ticket board, convert/link to task.
 * Imported once at startup (src/modules/register.ts): entity resolver and global-search source.
 * Tickets have no due date, so there is no calendar source.
 */
import type { FilterQuery, Types } from 'mongoose';
import { hasRoleAtLeast, ticketKeySchema, type SearchHitDto } from '@teamtrack/shared';
import { registerEntity } from '../../services/entityAccess';
import { registerSearchSource } from '../../services/discovery';
import { NotFoundError } from '../../errors/AppError';
import type { ITicket } from '../../models/Ticket';
import type { IProject } from '../../models/Project';
import { memberRepository, projectRepository } from '../../repositories/projectRepository';
import { projectsService } from '../projects/projects.service';
import { ticketRepository } from './ticketRepository';
import { ticketPath } from './tickets.mapper';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

registerEntity('ticket', async (ctx, id) => {
  const ticket = await ticketRepository.findById(ctx.workspaceId, id);
  if (!ticket) return null;
  try {
    const a = await projectsService.access(ctx, ticket.projectId);
    const writable = a.canEdit && a.project.status === 'active';
    return {
      type: 'ticket',
      id: ticket._id,
      projectId: ticket.projectId,
      projectName: a.project.name,
      key: ticket.key,
      title: ticket.title,
      path: ticketPath(ticket._id.toHexString()),
      canWrite: writable,
      canManage: writable && a.canManage,
      participants: [ticket.reporterId, ticket.assigneeId].filter((x): x is NonNullable<typeof x> => !!x),
    };
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
});

/** Title substring or exact key (TCK-12), in projects the caller can see. */
registerSearchSource('tickets', async (ctx, q, limit): Promise<SearchHitDto[]> => {
  const text = q.trim();
  if (!text || limit <= 0) return [];
  const filter: FilterQuery<ITicket> = { workspaceId: ctx.workspaceId };
  if (!hasRoleAtLeast(ctx.role, 'admin')) {
    const memberships = await memberRepository.listForUser(ctx.workspaceId, ctx.userId);
    const visible = await projectRepository.visibleIds(ctx.workspaceId, {
      memberOf: memberships.map((m) => m.projectId),
      includeWorkspaceVisible: ctx.role !== 'guest',
    });
    if (!visible.length) return [];
    filter.projectId = { $in: visible };
  }
  if (ticketKeySchema.safeParse(text).success) filter.key = text.toUpperCase();
  else filter.title = new RegExp(escapeRegex(text.slice(0, 100)), 'i');

  const hits = await ticketRepository.search(filter, Math.min(limit, 50));
  const projectIds = new Map<string, Types.ObjectId>(hits.map((h) => [h.projectId.toHexString(), h.projectId]));
  const projects = new Map<string, IProject>();
  await Promise.all(
    [...projectIds.entries()].map(async ([key, pid]) => {
      const p = await projectRepository.findById(ctx.workspaceId, pid);
      if (p) projects.set(key, p);
    }),
  );
  return hits.flatMap((h) => {
    const p = projects.get(h.projectId.toHexString());
    if (!p) return [];
    const status = p.workflow.ticketStatuses.find((s) => s.id === h.statusId)?.name ?? h.statusId;
    return [{ type: 'ticket' as const, id: h._id.toHexString(), title: `${h.key} ${h.title}`, subtitle: `${p.name} · ${status}`, path: ticketPath(h._id.toHexString()) }];
  });
});
