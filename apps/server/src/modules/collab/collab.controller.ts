import type { Request, Response } from 'express';
import {
  createCommentSchema,
  idParamsSchema,
  listActivityQuerySchema,
  listAttachmentsQuerySchema,
  listCommentsQuerySchema,
  mentionableQuerySchema,
  updateCommentSchema,
  uploadAttachmentQuerySchema,
  type CommentDto,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { commentsService } from './comments.service';
import { attachmentsService } from './attachments.service';
import { activityService } from './activity.service';

const sendComment = (res: Response, c: CommentDto, status = 200) => res.status(status).setHeader('ETag', etag(c.version)).json(c);

export const collabController = {
  async listComments(req: Request, res: Response) {
    res.json(await commentsService.list(requireAuth(req), parse(listCommentsQuerySchema, req.query)));
  },

  async createComment(req: Request, res: Response) {
    sendComment(res, await commentsService.create(requireAuth(req), parse(createCommentSchema, req.body)), 201);
  },

  async updateComment(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(updateCommentSchema, req.body);
    sendComment(res, await commentsService.update(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async removeComment(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await commentsService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  async mentionable(req: Request, res: Response) {
    res.json({ items: await commentsService.mentionable(requireAuth(req), parse(mentionableQuerySchema, req.query)) });
  },

  async listAttachments(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store'); // carries signed URLs
    res.json({ items: await attachmentsService.list(requireAuth(req), parse(listAttachmentsQuerySchema, req.query)) });
  },

  /** The raw file is the request body (express.raw on this route only); metadata is in the query string. */
  async uploadAttachment(req: Request, res: Response) {
    const q = parse(uploadAttachmentQuerySchema, req.query);
    res.status(201).json(await attachmentsService.upload(requireAuth(req), q, req.body));
  },

  async removeAttachment(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await attachmentsService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  async listActivity(req: Request, res: Response) {
    res.json(await activityService.list(requireAuth(req), parse(listActivityQuerySchema, req.query)));
  },
};
