import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { ProjectDto, TicketBoardDto, TicketDto, TicketResolution, TicketSeverity, TicketType, WorkflowStatusDto } from '@teamtrack/shared';
import { projectsApi } from '../api/endpoints';
import type { TicketListParams } from '../api/tickets';

/** Query keys in one place so invalidation can't drift from the queries. Everything sits under ['tickets']. */
export const tk = {
  all: ['tickets'] as const,
  lists: ['tickets', 'list'] as const,
  list: (params: TicketListParams) => ['tickets', 'list', params] as const,
  board: (projectId: string) => ['tickets', 'board', projectId] as const,
  ticket: (id: string) => ['tickets', 'one', id] as const,
  /** Active projects for pickers (first page; the API caps pages at 100). */
  projects: ['projects', 'active', 'picker'] as const,
};

export const TYPE_LABEL: Record<TicketType, string> = { bug: 'Bug', issue: 'Issue', request: 'Request', question: 'Question', incident: 'Incident' };
export const SEVERITY_LABEL: Record<TicketSeverity, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const RESOLUTION_LABEL: Record<TicketResolution, string> = {
  fixed: 'Fixed',
  wont_fix: "Won't fix",
  duplicate: 'Duplicate',
  cannot_reproduce: 'Cannot reproduce',
  by_design: 'By design',
};

export function sortedTicketStatuses(project: ProjectDto): WorkflowStatusDto[] {
  return [...project.workflow.ticketStatuses].sort((a, b) => a.order - b.order);
}

export function canEditProject(project: ProjectDto, isAdmin: boolean): boolean {
  return project.status === 'active' && (isAdmin || project.myRole === 'lead' || project.myRole === 'member');
}

/** Writes a fresh ticket from the server into every cache that shows it. */
export function syncTicket(qc: QueryClient, ticket: TicketDto): void {
  qc.setQueryData(tk.ticket(ticket.id), ticket);
  qc.setQueryData<TicketBoardDto>(tk.board(ticket.projectId), (b) => b && { ...b, tickets: b.tickets.map((t) => (t.id === ticket.id ? ticket : t)) });
  void qc.invalidateQueries({ queryKey: tk.lists });
}

/** After creates and deletes, positions change: refetch rather than patch. */
export function refreshTickets(qc: QueryClient, projectId: string): void {
  void qc.invalidateQueries({ queryKey: tk.board(projectId) });
  void qc.invalidateQueries({ queryKey: tk.lists });
}

export function useActiveProjects() {
  return useQuery({ queryKey: tk.projects, queryFn: () => projectsApi.list({ status: 'active' }), staleTime: 60_000 });
}

export function useProject(projectId: string | null) {
  return useQuery({ queryKey: ['project', projectId], queryFn: () => projectsApi.get(projectId!), enabled: !!projectId });
}
