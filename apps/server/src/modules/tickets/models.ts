import { Ticket } from '../../models/Ticket';

/** Phase 4: tickets. This module's Mongoose models, so `db:migrate` syncs their indexes. */
export const TICKETS_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [Ticket];
