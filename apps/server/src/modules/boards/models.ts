import { Board } from '../../models/Board';
import { BoardSnapshot } from '../../models/BoardSnapshot';

/** Phase 7: Excalidraw whiteboards, autosave, realtime sync, discussion: this module's Mongoose models, so `db:migrate` syncs their indexes. */
export const BOARDS_MODELS: ReadonlyArray<{ syncIndexes(): Promise<unknown> }> = [Board, BoardSnapshot];
