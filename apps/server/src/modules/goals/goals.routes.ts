import { Router } from 'express';
import { goalsController } from './goals.controller';

/** Phase 6: daily / weekly / monthly goals, progress, carry-over, rollover. Mounted after authentication in src/routes.ts. */
export function goalsRouter(): Router {
  const r = Router();
  r.get('/goals', goalsController.list);
  r.get('/goals/summary', goalsController.summary);
  r.post('/goals', goalsController.create);
  r.get('/goals/:id', goalsController.get);
  r.patch('/goals/:id', goalsController.update);
  r.patch('/goals/:id/progress', goalsController.progress);
  r.post('/goals/:id/link-task', goalsController.linkTask);
  r.delete('/goals/:id/link-task/:taskId', goalsController.unlinkTask);
  r.post('/goals/:id/carry-over', goalsController.carryOver);
  r.delete('/goals/:id', goalsController.remove);
  return r;
}
