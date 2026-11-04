/**
 * Phase 7: Excalidraw whiteboards, autosave, realtime sync, discussion.
 * Imported once at startup (src/modules/register.ts): entity resolver (comments, activity, notifications),
 * global search source and the board socket handlers.
 */
import { registerEntity } from '../../services/entityAccess';
import { registerSearchSource } from '../../services/discovery';
import { boardsService } from './boards.service';
import { registerBoardSockets } from './boards.realtime';

registerEntity('board', async (ctx, id) => {
  const l = await boardsService.resolve(ctx, id);
  if (!l) return null;
  const { board, a, canEdit } = l;
  return {
    type: 'board',
    id: board._id,
    projectId: board.projectId,
    projectName: a.project.name,
    key: board.title,
    title: board.title,
    path: `/boards/${board._id.toHexString()}`,
    canWrite: canEdit,
    canManage: canEdit && a.canManage,
    participants: [board.createdBy, board.lastEditedBy].filter((x): x is NonNullable<typeof x> => !!x),
  };
});

registerSearchSource('boards', (ctx, q, limit) => boardsService.search(ctx, q, limit));

registerBoardSockets();
