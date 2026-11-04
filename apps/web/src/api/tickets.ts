import type {
  ConvertTicketResultDto,
  CreateTicketInput,
  ListTicketsQuery,
  MoveTicketInput,
  Page,
  TicketBoardDto,
  TicketDto,
  UpdateTicketInput,
} from '@teamtrack/shared';
import { api } from './client';

const ifMatch = (version: number) => ({ headers: { 'If-Match': `"${version}"` } });

/** Query params for GET /tickets (all optional on the client; the server applies defaults). */
export type TicketListParams = Partial<Omit<ListTicketsQuery, 'cursor'>> & { cursor?: string | undefined };

export const ticketsApi = {
  board: (projectId: string) => api.get<TicketBoardDto>(`/projects/${projectId}/ticket-board`).then((r) => r.data),
  list: (params: TicketListParams) => api.get<Page<TicketDto>>('/tickets', { params }).then((r) => r.data),
  get: (id: string) => api.get<TicketDto>(`/tickets/${id}`).then((r) => r.data),
  create: (projectId: string, input: Partial<CreateTicketInput> & { title: string }) =>
    api.post<TicketDto>(`/projects/${projectId}/tickets`, input).then((r) => r.data),
  update: (id: string, input: UpdateTicketInput, version: number) =>
    api.patch<TicketDto>(`/tickets/${id}`, input, ifMatch(version)).then((r) => r.data),
  move: (id: string, input: MoveTicketInput, version: number) =>
    api.patch<TicketDto>(`/tickets/${id}/move`, input, ifMatch(version)).then((r) => r.data),
  remove: (id: string) => api.delete(`/tickets/${id}`),
  convertToTask: (id: string) => api.post<ConvertTicketResultDto>(`/tickets/${id}/convert-to-task`).then((r) => r.data),
  linkTask: (id: string, taskId: string) => api.post<TicketDto>(`/tickets/${id}/links`, { taskId }).then((r) => r.data),
  unlinkTask: (id: string, taskId: string) => api.delete<TicketDto>(`/tickets/${id}/links/${taskId}`).then((r) => r.data),
};
