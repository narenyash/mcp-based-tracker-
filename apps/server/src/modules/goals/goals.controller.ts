import type { Request, Response } from 'express';
import {
  createGoalSchema,
  goalProgressSchema,
  goalSummaryQuerySchema,
  goalTaskParamsSchema,
  idParamsSchema,
  linkGoalTaskSchema,
  listGoalsQuerySchema,
  updateGoalSchema,
  type GoalDto,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { goalsService } from './goals.service';

const sendGoal = (res: Response, goal: GoalDto, status = 200) => res.status(status).setHeader('ETag', etag(goal.version)).json(goal);

export const goalsController = {
  async list(req: Request, res: Response) {
    res.json(await goalsService.list(requireAuth(req), parse(listGoalsQuerySchema, req.query)));
  },

  async summary(req: Request, res: Response) {
    res.json(await goalsService.summary(requireAuth(req), parse(goalSummaryQuerySchema, req.query)));
  },

  async create(req: Request, res: Response) {
    sendGoal(res, await goalsService.create(requireAuth(req), parse(createGoalSchema, req.body)), 201);
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendGoal(res, await goalsService.get(requireAuth(req), id));
  },

  async update(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(updateGoalSchema, req.body);
    sendGoal(res, await goalsService.update(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async progress(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(goalProgressSchema, req.body);
    sendGoal(res, await goalsService.progress(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async linkTask(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { taskId } = parse(linkGoalTaskSchema, req.body);
    sendGoal(res, await goalsService.linkTask(requireAuth(req), id, taskId));
  },

  async unlinkTask(req: Request, res: Response) {
    const { id, taskId } = parse(goalTaskParamsSchema, req.params);
    sendGoal(res, await goalsService.unlinkTask(requireAuth(req), id, taskId));
  },

  async carryOver(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendGoal(res, await goalsService.carryOver(requireAuth(req), id), 201);
  },

  async remove(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await goalsService.remove(requireAuth(req), id);
    res.status(204).end();
  },
};
