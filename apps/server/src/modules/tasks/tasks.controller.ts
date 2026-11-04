import type { Request, Response } from 'express';
import {
  addChecklistItemSchema,
  checklistParamsSchema,
  createLabelSchema,
  createTaskSchema,
  idParamsSchema,
  labelParamsSchema,
  listTasksQuerySchema,
  moveTaskSchema,
  updateChecklistItemSchema,
  updateTaskSchema,
  type TaskDto,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { tasksService } from './tasks.service';

const sendTask = (res: Response, task: TaskDto, status = 200) => res.status(status).setHeader('ETag', etag(task.version)).json(task);

export const tasksController = {
  async board(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json(await tasksService.board(requireAuth(req), id));
  },

  async list(req: Request, res: Response) {
    res.json(await tasksService.list(requireAuth(req), parse(listTasksQuerySchema, req.query)));
  },

  async create(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendTask(res, await tasksService.create(requireAuth(req), id, parse(createTaskSchema, req.body)), 201);
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendTask(res, await tasksService.get(requireAuth(req), id));
  },

  async update(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(updateTaskSchema, req.body);
    sendTask(res, await tasksService.update(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async move(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(moveTaskSchema, req.body);
    sendTask(res, await tasksService.move(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async remove(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await tasksService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  async addChecklistItem(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { text } = parse(addChecklistItemSchema, req.body);
    sendTask(res, await tasksService.addChecklistItem(requireAuth(req), id, text), 201);
  },

  async updateChecklistItem(req: Request, res: Response) {
    const { id, itemId } = parse(checklistParamsSchema, req.params);
    sendTask(res, await tasksService.updateChecklistItem(requireAuth(req), id, itemId, parse(updateChecklistItemSchema, req.body)));
  },

  async removeChecklistItem(req: Request, res: Response) {
    const { id, itemId } = parse(checklistParamsSchema, req.params);
    sendTask(res, await tasksService.removeChecklistItem(requireAuth(req), id, itemId));
  },

  async listLabels(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json({ items: await tasksService.listLabels(requireAuth(req), id) });
  },

  async createLabel(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.status(201).json(await tasksService.createLabel(requireAuth(req), id, parse(createLabelSchema, req.body)));
  },

  async removeLabel(req: Request, res: Response) {
    const { id, labelId } = parse(labelParamsSchema, req.params);
    await tasksService.removeLabel(requireAuth(req), id, labelId);
    res.status(204).end();
  },
};
