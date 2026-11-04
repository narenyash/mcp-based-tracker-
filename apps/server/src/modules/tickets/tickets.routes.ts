import { Router } from 'express';
import { ticketsController } from './tickets.controller';

/** Phase 4: tickets (bugs, issues, requests), ticket board, convert/link to task. Mounted after authentication in src/routes.ts. */
export function ticketsRouter(): Router {
  const r = Router();
  r.get('/projects/:id/ticket-board', ticketsController.board);
  r.post('/projects/:id/tickets', ticketsController.create);

  r.get('/tickets', ticketsController.list);
  r.get('/tickets/:id', ticketsController.get);
  r.patch('/tickets/:id', ticketsController.update);
  r.patch('/tickets/:id/move', ticketsController.move);
  r.delete('/tickets/:id', ticketsController.remove);
  r.post('/tickets/:id/convert-to-task', ticketsController.convertToTask);
  r.post('/tickets/:id/links', ticketsController.linkTask);
  r.delete('/tickets/:id/links/:taskId', ticketsController.unlinkTask);
  return r;
}
