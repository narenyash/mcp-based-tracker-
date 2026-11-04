import type { Types } from 'mongoose';
import {
  SNAKE_LEADERBOARD_SIZE,
  type SnakeLeaderboardDto,
  type SnakeLeaderboardEntryDto,
  type SnakeScoreResultDto,
  type SubmitSnakeScoreInput,
} from '@teamtrack/shared';
import type { AuthContext } from '../../auth/context';
import { SnakeScore, type ISnakeScore } from '../../models/SnakeScore';
import { userRepository } from '../../repositories/userRepository';

const hex = (id: Types.ObjectId) => id.toHexString();
const isDuplicateKey = (e: unknown) => (e as { code?: number }).code === 11000;

/** Ties go to whoever reached the score first. */
const rankOf = async (ctx: AuthContext, row: ISnakeScore) =>
  1 +
  (await SnakeScore.countDocuments({
    workspaceId: ctx.workspaceId,
    $or: [{ best: { $gt: row.best } }, { best: row.best, bestAt: { $lt: row.bestAt } }],
  }));

export const gamesService = {
  async leaderboard(ctx: AuthContext): Promise<SnakeLeaderboardDto> {
    const [rows, mine] = await Promise.all([
      SnakeScore.find({ workspaceId: ctx.workspaceId }).sort({ best: -1, bestAt: 1 }).limit(SNAKE_LEADERBOARD_SIZE).lean<ISnakeScore[]>(),
      SnakeScore.findOne({ workspaceId: ctx.workspaceId, userId: ctx.userId }).lean<ISnakeScore>(),
    ]);
    const users = new Map(
      (await userRepository.findByIds(ctx.workspaceId, [...rows.map((r) => r.userId), ctx.userId])).map((u) => [hex(u._id), u]),
    );
    const entry = (r: ISnakeScore, rank: number): SnakeLeaderboardEntryDto => ({
      rank,
      user: { id: hex(r.userId), name: users.get(hex(r.userId))?.name ?? 'Former member' },
      best: r.best,
      bestAt: r.bestAt.toISOString(),
      games: r.games,
    });
    const top = rows.map((r, i) => entry(r, i + 1));
    const meInTop = top.find((e) => e.user.id === hex(ctx.userId));
    return { top, me: meInTop ?? (mine ? entry(mine, await rankOf(ctx, mine)) : null) };
  },

  async submit(ctx: AuthContext, input: SubmitSnakeScoreInput): Promise<SnakeScoreResultDto> {
    const now = new Date();
    const filter = { workspaceId: ctx.workspaceId, userId: ctx.userId };
    const count = () => SnakeScore.updateOne(filter, { $inc: { games: 1 }, $setOnInsert: { best: 0, bestAt: now } }, { upsert: true });
    try {
      await count();
    } catch (e) {
      // Two first games at once: the other insert won, so this one is now a plain update.
      if (!isDuplicateKey(e)) throw e;
      await count();
    }
    // Conditional on the stored best, so concurrent submits can't lower it.
    const raised = await SnakeScore.updateOne({ ...filter, best: { $lt: input.score } }, { $set: { best: input.score, bestAt: now } });
    return { leaderboard: await gamesService.leaderboard(ctx), personalBest: raised.modifiedCount > 0 };
  },
};
