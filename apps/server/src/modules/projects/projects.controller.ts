import type { Request, Response } from 'express';
import {
  addMemberSchema,
  createProjectSchema,
  idParamsSchema,
  listProjectsQuerySchema,
  memberParamsSchema,
  updateMemberSchema,
  updateProjectSchema,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { projectsService } from './projects.service';

export const projectsController = {
  async list(req: Request, res: Response) {
    res.json(await projectsService.list(requireAuth(req), parse(listProjectsQuerySchema, req.query)));
  },

  async create(req: Request, res: Response) {
    const project = await projectsService.create(requireAuth(req), parse(createProjectSchema, req.body));
    res.status(201).setHeader('ETag', etag(project.version)).json(project);
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const project = await projectsService.get(requireAuth(req), id);
    res.setHeader('ETag', etag(project.version)).json(project);
  },

  async update(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(updateProjectSchema, req.body);
    const project = await projectsService.update(requireAuth(req), id, input, requireIfMatch(req));
    res.setHeader('ETag', etag(project.version)).json(project);
  },

  async remove(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await projectsService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  async listMembers(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json({ items: await projectsService.listMembers(requireAuth(req), id) });
  },

  async assignable(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json({ items: await projectsService.assignable(requireAuth(req), id) });
  },

  async addMember(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { userId, role } = parse(addMemberSchema, req.body);
    await projectsService.addMember(requireAuth(req), id, userId, role);
    res.status(204).end();
  },

  async updateMember(req: Request, res: Response) {
    const { id, userId } = parse(memberParamsSchema, req.params);
    const { role } = parse(updateMemberSchema, req.body);
    await projectsService.updateMember(requireAuth(req), id, userId, role);
    res.status(204).end();
  },

  async removeMember(req: Request, res: Response) {
    const { id, userId } = parse(memberParamsSchema, req.params);
    await projectsService.removeMember(requireAuth(req), id, userId);
    res.status(204).end();
  },
};
