import type { Request, Response } from 'express';
import {
  calendarQuerySchema,
  searchQuerySchema,
  standupFeedQuerySchema,
  standupHistoryQuerySchema,
  upsertStandupSchema,
} from '@teamtrack/shared';
import { etag, parse, requireIfMatch } from '../../middleware/validate';
import { requireAuth } from '../../auth/context';
import { discoveryService } from './discovery.service';
import { standupsService } from './standups.service';

/** If-Match is optional on PUT /standups/me (a first save has no version); the service decides when it's required. */
const optionalIfMatch = (req: Request) => (req.get('if-match') === undefined ? undefined : requireIfMatch(req));

export const planningController = {
  async search(req: Request, res: Response) {
    res.json(await discoveryService.search(requireAuth(req), parse(searchQuerySchema, req.query)));
  },

  async calendar(req: Request, res: Response) {
    res.json(await discoveryService.calendar(requireAuth(req), parse(calendarQuerySchema, req.query)));
  },

  async standupFeed(req: Request, res: Response) {
    res.json(await standupsService.feed(requireAuth(req), parse(standupFeedQuerySchema, req.query)));
  },

  async upsertMyStandup(req: Request, res: Response) {
    const input = parse(upsertStandupSchema, req.body);
    const { standup, created } = await standupsService.upsertMine(requireAuth(req), input, optionalIfMatch(req));
    res.status(created ? 201 : 200).setHeader('ETag', etag(standup.version)).json(standup);
  },

  async myStandupHistory(req: Request, res: Response) {
    res.json(await standupsService.history(requireAuth(req), parse(standupHistoryQuerySchema, req.query)));
  },

  async myStandupSuggestions(req: Request, res: Response) {
    res.json(await standupsService.suggestions(requireAuth(req)));
  },
};
