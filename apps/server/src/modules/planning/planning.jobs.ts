import type { Job } from '../../jobs/scheduler';

/**
 * Scheduled jobs for this module (leased, so one instance runs each). None: the standup reminder is an
 * in-app nudge computed when the Standups page loads (`nudge` on GET /standups), not a notification.
 */
export const planningJobs: Job[] = [];
