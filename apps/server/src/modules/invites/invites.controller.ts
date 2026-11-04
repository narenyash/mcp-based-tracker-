import type { Request, Response } from 'express';
import { z } from 'zod';
import { acceptInviteSchema, createInviteSchema, idParamsSchema, inviteTokenSchema } from '@teamtrack/shared';
import { parse } from '../../middleware/validate';
import { clientMeta, requireAuth } from '../../auth/context';
import { sendSession } from '../auth/auth.controller';
import { invitesService } from './invites.service';

const tokenParams = z.object({ token: inviteTokenSchema });

export const invitesController = {
  async create(req: Request, res: Response) {
    const input = parse(createInviteSchema, req.body);
    res.status(201).json(await invitesService.create(requireAuth(req), input));
  },

  async list(req: Request, res: Response) {
    res.json({ items: await invitesService.list(requireAuth(req)) });
  },

  async revoke(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await invitesService.revoke(requireAuth(req), id);
    res.status(204).end();
  },

  async getJoinLink(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await invitesService.getJoinLink(requireAuth(req)));
  },

  async generateJoinLink(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(await invitesService.generateJoinLink(requireAuth(req)));
  },

  async revokeJoinLink(req: Request, res: Response) {
    await invitesService.revokeJoinLink(requireAuth(req));
    res.status(204).end();
  },

  async preview(req: Request, res: Response) {
    const { token } = parse(tokenParams, req.params);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await invitesService.preview(token));
  },

  async accept(req: Request, res: Response) {
    const input = parse(acceptInviteSchema, req.body);
    sendSession(res, await invitesService.accept(input, clientMeta(req)), 201);
  },
};
