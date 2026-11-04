import { Router } from 'express';
import { reportsController } from './reports.controller';

/**
 * Phase 9: dashboard and reports. Mounted after authentication in src/routes.ts. Both endpoints are
 * open to every role; the service narrows what each role sees (members and guests get their own work).
 */
export function reportsRouter(): Router {
  const r = Router();

  r.get('/dashboard/me', reportsController.myDashboard);
  r.get('/reports/team', reportsController.team);

  return r;
}
