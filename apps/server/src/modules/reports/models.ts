/** Phase 9: dashboard and reports: list this module's Mongoose models so `db:migrate` syncs their indexes. */
export const REPORTS_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [];
