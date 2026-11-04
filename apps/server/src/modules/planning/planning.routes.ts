import { Router } from 'express';
import { planningController } from './planning.controller';

/** Phase 8: calendar, daily standups, global search. Mounted after authentication in src/routes.ts. */
export function planningRouter(): Router {
  const r = Router();

  r.get('/search', planningController.search);
  r.get('/calendar', planningController.calendar);

  r.get('/standups', planningController.standupFeed);
  r.put('/standups/me', planningController.upsertMyStandup);
  r.get('/standups/me/history', planningController.myStandupHistory);
  r.get('/standups/me/suggestions', planningController.myStandupSuggestions);

  return r;
}
