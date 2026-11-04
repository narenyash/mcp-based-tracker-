import type { Request, Response } from 'express';
import {
  idParamsSchema,
  listUsersQuerySchema,
  updateMeSchema,
  updatePreferencesSchema,
  updateRoleSchema,
  updateStatusSchema,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { usersService } from './users.service';

export const usersController = {
  async list(req: Request, res: Response) {
    res.json(await usersService.list(requireAuth(req), parse(listUsersQuerySchema, req.query)));
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const user = await usersService.get(requireAuth(req), id);
    res.setHeader('ETag', etag(user.version)).json(user);
  },

  async updateMe(req: Request, res: Response) {
    const input = parse(updateMeSchema, req.body);
    const user = await usersService.updateMe(requireAuth(req), input, requireIfMatch(req));
    res.setHeader('ETag', etag(user.version)).json(user);
  },

  async preferences(req: Request, res: Response) {
    res.json(await usersService.preferences(requireAuth(req)));
  },

  async updatePreferences(req: Request, res: Response) {
    res.json(await usersService.updatePreferences(requireAuth(req), parse(updatePreferencesSchema, req.body)));
  },

  async changeRole(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { role } = parse(updateRoleSchema, req.body);
    res.json(await usersService.changeRole(requireAuth(req), id, role));
  },

  async changeStatus(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { status } = parse(updateStatusSchema, req.body);
    res.json(await usersService.changeStatus(requireAuth(req), id, status));
  },
};
