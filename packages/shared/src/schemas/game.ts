/** Snake on the home page: a workspace leaderboard of each person's best score. */
import { z } from 'zod';
import type { PersonRef } from '../types';

/** One apple is worth this many points. */
export const SNAKE_POINTS_PER_APPLE = 10;
/** Playfield size, in cells. The server uses it to cap scores at a full board. */
export const SNAKE_COLS = 24;
export const SNAKE_ROWS = 14;
export const SNAKE_MAX_SCORE = SNAKE_COLS * SNAKE_ROWS * SNAKE_POINTS_PER_APPLE;
export const SNAKE_LEADERBOARD_SIZE = 10;

export const submitSnakeScoreSchema = z
  .object({
    score: z.number().int().min(0).max(SNAKE_MAX_SCORE).multipleOf(SNAKE_POINTS_PER_APPLE),
  })
  .strict();
export type SubmitSnakeScoreInput = z.infer<typeof submitSnakeScoreSchema>;

export interface SnakeLeaderboardEntryDto {
  rank: number;
  user: PersonRef;
  best: number;
  /** ISO time the best score was set. */
  bestAt: string;
  games: number;
}

export interface SnakeLeaderboardDto {
  top: SnakeLeaderboardEntryDto[];
  /** My own row, also when I'm outside the top list; null before my first game. */
  me: SnakeLeaderboardEntryDto | null;
}

export interface SnakeScoreResultDto {
  leaderboard: SnakeLeaderboardDto;
  /** True when this game beat my previous best. */
  personalBest: boolean;
}
