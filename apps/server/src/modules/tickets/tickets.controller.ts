import type { Request, Response } from 'express';
import {
  createTicketSchema,
  idParamsSchema,
  linkTicketTaskSchema,
  listTicketsQuerySchema,
  moveTicketSchema,
  ticketLinkParamsSchema,
  updateTicketSchema,
  type TicketDto,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { ticketsService } from './tickets.service';

const sendTicket = (res: Response, ticket: TicketDto, status = 200) => res.status(status).setHeader('ETag', etag(ticket.version)).json(ticket);

export const ticketsController = {
  async board(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    res.json(await ticketsService.board(requireAuth(req), id));
  },

  async list(req: Request, res: Response) {
    res.json(await ticketsService.list(requireAuth(req), parse(listTicketsQuerySchema, req.query)));
  },

  async create(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendTicket(res, await ticketsService.create(requireAuth(req), id, parse(createTicketSchema, req.body)), 201);
  },

  async get(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    sendTicket(res, await ticketsService.get(requireAuth(req), id));
  },

  async update(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(updateTicketSchema, req.body);
    sendTicket(res, await ticketsService.update(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async move(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const input = parse(moveTicketSchema, req.body);
    sendTicket(res, await ticketsService.move(requireAuth(req), id, input, requireIfMatch(req)));
  },

  async remove(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    await ticketsService.remove(requireAuth(req), id);
    res.status(204).end();
  },

  async convertToTask(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const result = await ticketsService.convertToTask(requireAuth(req), id);
    res.status(201).setHeader('ETag', etag(result.ticket.version)).json(result);
  },

  async linkTask(req: Request, res: Response) {
    const { id } = parse(idParamsSchema, req.params);
    const { taskId } = parse(linkTicketTaskSchema, req.body);
    sendTicket(res, await ticketsService.linkTask(requireAuth(req), id, taskId));
  },

  async unlinkTask(req: Request, res: Response) {
    const { id, taskId } = parse(ticketLinkParamsSchema, req.params);
    sendTicket(res, await ticketsService.unlinkTask(requireAuth(req), id, taskId));
  },
};
