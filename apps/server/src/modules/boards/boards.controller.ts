import type { Request, Response } from 'express';
import {
  createWhiteboardSchema,
  idParamsSchema,
  listWhiteboardsQuerySchema,
  saveSceneSchema,
  snapshotParamsSchema,
  updateWhiteboardSchema,
  whiteboardFileParamsSchema,
  type WhiteboardDto,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { ValidationError } from '../../errors/AppError';
import { boardsService } from './boards.service';
import { decodeGzipJson } from './boards.scene';

const sendBoard = (res: Response, board: WhiteboardDto, status = 200) => res.status(status).setHeader('ETag', etag(board.version)).json(board);

/** Raw-body routes: express.raw leaves `req.body` unset when the Content-Type doesn't match. */
function rawBody(req: Request): Buffer {
  if (!Buffer.isBuffer(req.body)) throw new ValidationError([{ path: '(body)', message: 'Send the file as the raw request body with its image Content-Type' }]);
  return req.body;
}

export const boardsController = {
  async list(req: Request, res: Response) {
    res.json(await boardsService.list(requireAuth(req), parse(listWhiteboardsQuerySchema, req.query)));
  },

  async create(req: Request, res: Response) {
    sendBoard(res, await boardsService.create(requireAuth(req), parse(createWhiteboardSchema, req.body)), 201);
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendBoard(res, await boardsService.get(requireAuth(req), id));
  },

  async update(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { title } = parse(updateWhiteboardSchema, req.body);
    sendBoard(res, await boardsService.rename(requireAuth(req), id, title, requireIfMatch(req)));
  },

  async remove(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await boardsService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  /** JSON, or gzipped JSON (`Content-Type: application/gzip`) for scenes beyond the 1 MB JSON limit. */
  async saveScene(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const body: unknown = Buffer.isBuffer(req.body) ? await decodeGzipJson(req.body) : req.body;
    sendBoard(res, await boardsService.saveScene(requireAuth(req), id, parse(saveSceneSchema, body)));
  },

  async snapshots(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json({ items: await boardsService.snapshots(requireAuth(req), id) });
  },

  async restore(req: Request, res: Response) {
    const { id, snapshotId } = parse(snapshotParamsSchema, req.params);
    sendBoard(res, await boardsService.restore(requireAuth(req), id, snapshotId));
  },

  async uploadFile(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.status(201).json(await boardsService.uploadFile(requireAuth(req), id, rawBody(req)));
  },

  async file(req: Request, res: Response) {
    const { id, fileId } = parse(whiteboardFileParamsSchema, req.params);
    res.setHeader('Cache-Control', 'private, no-store').redirect(302, await boardsService.fileUrl(requireAuth(req), id, fileId));
  },

  async fileContent(req: Request, res: Response) {
    const { id, fileId } = parse(whiteboardFileParamsSchema, req.params);
    const { body, mimeType } = await boardsService.fileContent(requireAuth(req), id, fileId);
    // Uploaded files never change (new upload = new id), so the browser may keep them.
    res.setHeader('Content-Type', mimeType).setHeader('X-Content-Type-Options', 'nosniff').setHeader('Cache-Control', 'private, max-age=86400, immutable').end(body);
  },

  async setThumbnail(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await boardsService.setThumbnail(requireAuth(req), id, rawBody(req));
    res.status(204).end();
  },
};
