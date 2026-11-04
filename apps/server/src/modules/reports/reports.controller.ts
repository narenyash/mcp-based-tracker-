import type { Request, Response } from 'express';
import { teamReportQuerySchema } from '@teamtrack/shared';
import { requireAuth } from '../../auth/context';
import { parse } from '../../middleware/validate';
import { reportsService } from './reports.service';

/** Report data is per-user and changes constantly: never let a shared cache keep it. */
const noStore = (res: Response) => res.setHeader('Cache-Control', 'private, no-store');

export const reportsController = {
  async myDashboard(req: Request, res: Response) {
    noStore(res).json(await reportsService.myDashboard(requireAuth(req)));
  },

  async team(req: Request, res: Response) {
    noStore(res).json(
      await reportsService.team(requireAuth(req), parse(teamReportQuerySchema, req.query)),
    );
  },
};
