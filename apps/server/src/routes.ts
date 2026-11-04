import { Router } from 'express';
import { authenticate, requireRole } from './middleware/auth';
import { apiLimiter, authLimiter, loginLimiter } from './middleware/rateLimit';
import { idempotency } from './middleware/idempotency';
import { authController } from './modules/auth/auth.controller';
import { invitesController } from './modules/invites/invites.controller';
import { usersController } from './modules/users/users.controller';
import { projectsController } from './modules/projects/projects.controller';
import { tasksController } from './modules/tasks/tasks.controller';
import { notificationsController } from './modules/notifications/notifications.controller';
import { ticketsRouter } from './modules/tickets/tickets.routes';
import { collabRouter } from './modules/collab/collab.routes';
import { goalsRouter } from './modules/goals/goals.routes';
import { boardsRouter } from './modules/boards/boards.routes';
import { planningRouter } from './modules/planning/planning.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { gamesRouter } from './modules/games/games.routes';
import { filesRouter } from './services/storage';

export function apiRouter(): Router {
  const r = Router();

  // Public (cookie- or body-authenticated) auth endpoints.
  r.post('/auth/signup', authLimiter, authController.signup);
  r.post('/auth/login', loginLimiter, authController.login);
  r.post('/auth/refresh', authLimiter, authController.refresh);
  r.post('/auth/logout', authLimiter, authController.logout);
  r.get('/invites/:token/preview', authLimiter, invitesController.preview);
  r.post('/invites/accept', authLimiter, invitesController.accept);
  // Signed download links for the in-memory storage driver (the signature is the credential).
  r.use(filesRouter());

  // Everything below requires a valid access token.
  r.use(authenticate, apiLimiter, idempotency);

  r.get('/auth/me', authController.me);
  r.post('/auth/logout-all', authController.logoutAll);

  r.get('/invites', requireRole('manager'), invitesController.list);
  r.post('/invites', requireRole('manager'), invitesController.create);
  // Before /invites/:id, which would otherwise capture "link" as an id.
  r.get('/invites/link', requireRole('owner'), invitesController.getJoinLink);
  r.post('/invites/link', requireRole('owner'), invitesController.generateJoinLink);
  r.delete('/invites/link', requireRole('owner'), invitesController.revokeJoinLink);
  r.delete('/invites/:id', requireRole('manager'), invitesController.revoke);

  r.get('/users', usersController.list);
  r.patch('/users/me', usersController.updateMe);
  r.get('/users/me/preferences', usersController.preferences);
  r.patch('/users/me/preferences', usersController.updatePreferences);
  r.get('/users/:id', usersController.get);
  r.patch('/users/:id/role', requireRole('admin'), usersController.changeRole);
  r.patch('/users/:id/status', requireRole('admin'), usersController.changeStatus);

  r.get('/projects', projectsController.list);
  r.post('/projects', projectsController.create);
  r.get('/projects/:id', projectsController.get);
  r.patch('/projects/:id', projectsController.update);
  r.delete('/projects/:id', projectsController.remove);
  r.get('/projects/:id/members', projectsController.listMembers);
  r.get('/projects/:id/assignable', projectsController.assignable);
  r.post('/projects/:id/members', projectsController.addMember);
  r.patch('/projects/:id/members/:userId', projectsController.updateMember);
  r.delete('/projects/:id/members/:userId', projectsController.removeMember);
  r.get('/projects/:id/board', tasksController.board);
  r.post('/projects/:id/tasks', tasksController.create);
  r.get('/projects/:id/labels', tasksController.listLabels);
  r.post('/projects/:id/labels', tasksController.createLabel);
  r.delete('/projects/:id/labels/:labelId', tasksController.removeLabel);

  r.get('/tasks', tasksController.list);
  r.get('/tasks/:id', tasksController.get);
  r.patch('/tasks/:id', tasksController.update);
  r.patch('/tasks/:id/move', tasksController.move);
  r.delete('/tasks/:id', tasksController.remove);
  r.post('/tasks/:id/checklist', tasksController.addChecklistItem);
  r.patch('/tasks/:id/checklist/:itemId', tasksController.updateChecklistItem);
  r.delete('/tasks/:id/checklist/:itemId', tasksController.removeChecklistItem);

  r.get('/notifications', notificationsController.list);
  r.get('/notifications/unread-count', notificationsController.unreadCount);
  r.post('/notifications/read-all', notificationsController.markAllRead);
  r.post('/notifications/:id/read', notificationsController.markRead);

  r.use(ticketsRouter());
  r.use(collabRouter());
  r.use(goalsRouter());
  r.use(boardsRouter());
  r.use(planningRouter());
  r.use(reportsRouter());
  r.use(gamesRouter());

  return r;
}
