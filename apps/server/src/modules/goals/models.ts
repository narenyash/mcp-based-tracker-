import { Goal } from '../../models/Goal';

/** Phase 6: daily / weekly / monthly goals, progress, carry-over, rollover: list this module's Mongoose models so `db:migrate` syncs their indexes. */
export const GOALS_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [Goal];
