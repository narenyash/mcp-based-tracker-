import { dueReminders } from './dueReminders';
import { goalsJobs } from '../modules/goals/goals.jobs';
import { planningJobs } from '../modules/planning/planning.jobs';

export const ALL_JOBS = [dueReminders, ...goalsJobs, ...planningJobs];
