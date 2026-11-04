import type {
  CreateGoalInput,
  GoalDetailDto,
  GoalDto,
  GoalListDto,
  GoalPeriod,
  GoalProgressInput,
  GoalStatus,
  GoalSummaryDto,
  UpdateGoalInput,
} from '@teamtrack/shared';
import { api } from './client';

const ifMatch = (version: number) => ({ headers: { 'If-Match': `"${version}"` } });

/** Query params for GET /goals (all optional on the client; the server applies defaults). */
export interface GoalListParams {
  period: GoalPeriod;
  /** Any day inside the period (YYYY-MM-DD); omitted = today in the workspace timezone. */
  date?: string | undefined;
  /** `me`, `team` or a user id. */
  owner?: string | undefined;
  projectId?: string | undefined;
  status?: GoalStatus | undefined;
  limit?: number | undefined;
}

/** What the client sends on create (the server fills defaults for everything else). */
export type CreateGoalBody = Partial<CreateGoalInput> & Pick<CreateGoalInput, 'title' | 'period'>;

export const goalsApi = {
  list: (params: GoalListParams) => api.get<GoalListDto>('/goals', { params }).then((r) => r.data),
  summary: (params: { period: GoalPeriod; date?: string | undefined }) => api.get<GoalSummaryDto>('/goals/summary', { params }).then((r) => r.data),
  get: (id: string) => api.get<GoalDetailDto>(`/goals/${id}`).then((r) => r.data),
  create: (input: CreateGoalBody) => api.post<GoalDto>('/goals', input).then((r) => r.data),
  update: (id: string, input: UpdateGoalInput, version: number) => api.patch<GoalDto>(`/goals/${id}`, input, ifMatch(version)).then((r) => r.data),
  progress: (id: string, input: GoalProgressInput, version: number) =>
    api.patch<GoalDto>(`/goals/${id}/progress`, input, ifMatch(version)).then((r) => r.data),
  linkTask: (id: string, taskId: string) => api.post<GoalDto>(`/goals/${id}/link-task`, { taskId }).then((r) => r.data),
  unlinkTask: (id: string, taskId: string) => api.delete<GoalDto>(`/goals/${id}/link-task/${taskId}`).then((r) => r.data),
  carryOver: (id: string) => api.post<GoalDto>(`/goals/${id}/carry-over`).then((r) => r.data),
  remove: (id: string) => api.delete(`/goals/${id}`),
};
