import { Router, type Request, type Response } from 'express';
import { submitSnakeScoreSchema } from '@teamtrack/shared';
import { requireAuth } from '../../auth/context';
import { parse } from '../../middleware/validate';
import { gamesService } from './games.service';

/** Snake on the home page. Mounted after authentication in src/routes.ts. */
export function gamesRouter(): Router {
  const r = Router();

  r.get('/games/snake/leaderboard', async (req: Request, res: Response) => {
    res.json(await gamesService.leaderboard(requireAuth(req)));
  });

  r.post('/games/snake/scores', async (req: Request, res: Response) => {
    res.status(201).json(await gamesService.submit(requireAuth(req), parse(submitSnakeScoreSchema, req.body)));
  });

  return r;
}
