import { Standup } from '../../models/Standup';

/** Phase 8: calendar, daily standups, global search: list this module's Mongoose models so `db:migrate` syncs their indexes. */
export const PLANNING_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [Standup];
