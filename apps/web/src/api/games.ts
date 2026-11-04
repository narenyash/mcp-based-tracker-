import type { SnakeLeaderboardDto, SnakeScoreResultDto } from '@teamtrack/shared';
import { api } from './client';

export const gamesApi = {
  snakeLeaderboard: () => api.get<SnakeLeaderboardDto>('/games/snake/leaderboard').then((r) => r.data),
  submitSnakeScore: (score: number) => api.post<SnakeScoreResultDto>('/games/snake/scores', { score }).then((r) => r.data),
};

export const gameKeys = {
  snakeLeaderboard: ['games', 'snake', 'leaderboard'] as const,
};
