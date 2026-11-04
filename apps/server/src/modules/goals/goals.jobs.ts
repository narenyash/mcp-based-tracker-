import type { Job } from '../../jobs/scheduler';
import { goalsService } from './goals.service';

/** Closes goals whose period ended (in the workspace timezone; periodEnd is stored as that instant). */
export const goalRollover: Job = {
  name: 'goal-rollover',
  everyMs: 15 * 60_000,
  leaseMs: 10 * 60_000,
  run: async () => {
    await goalsService.rollover();
  },
};

/** Scheduled jobs for this module (leased, so one instance runs each). */
export const goalsJobs: Job[] = [goalRollover];
