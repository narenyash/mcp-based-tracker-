import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { idParamsSchema, listNotificationsQuerySchema, type NotificationDto, type Page } from '@teamtrack/shared';
import { parse } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { NotFoundError } from '../../errors/AppError';
import { notificationRepository } from '../../repositories/notificationRepository';
import { toNotificationDto } from '../dto';

/** The bell. Every query is scoped to the caller, so ids of other people's notifications are just 404s. */
export const notificationsController = {
  async list(req: Request, res: Response) {
    const ctx = requireAuth(req);
    const q = parse(listNotificationsQuerySchema, req.query);
    const page = await notificationRepository.list(ctx.workspaceId, ctx.userId, q);
    const body: Page<NotificationDto> = { items: page.items.map(toNotificationDto), nextCursor: page.nextCursor };
    res.json(body);
  },

  async unreadCount(req: Request, res: Response) {
    const ctx = requireAuth(req);
    res.json({ count: await notificationRepository.countUnread(ctx.workspaceId, ctx.userId) });
  },

  async markRead(req: Request, res: Response) {
    const ctx = requireAuth(req);
    const { id } = parse(idParamsSchema, req.params);
    if (!(await notificationRepository.markRead(ctx.workspaceId, ctx.userId, new Types.ObjectId(id)))) throw new NotFoundError('Notification');
    res.status(204).end();
  },

  async markAllRead(req: Request, res: Response) {
    const ctx = requireAuth(req);
    res.json({ updated: await notificationRepository.markAllRead(ctx.workspaceId, ctx.userId) });
  },
};
