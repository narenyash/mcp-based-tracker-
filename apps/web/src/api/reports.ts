import type { MyDashboardDto, TeamReportDto } from '@teamtrack/shared';
import { api } from './client';

export interface TeamReportParams {
  projectId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** Drops empty filters so the server applies its defaults. */
const compact = (p: TeamReportParams) =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => !!v));

export const reportsApi = {
  myDashboard: () => api.get<MyDashboardDto>('/dashboard/me').then((r) => r.data),
  team: (params: TeamReportParams) =>
    api.get<TeamReportDto>('/reports/team', { params: compact(params) }).then((r) => r.data),
};

/**
 * Query keys. The dashboard lives under ['tasks'] on purpose: live task events already invalidate that
 * prefix (lib/realtime.ts), so the dashboard refreshes when my work changes without a socket hook here.
 */
export const reportKeys = {
  dashboard: ['tasks', 'dashboard', 'me'] as const,
  team: (p: TeamReportParams) =>
    ['reports', 'team', p.projectId ?? '', p.from ?? '', p.to ?? ''] as const,
};
