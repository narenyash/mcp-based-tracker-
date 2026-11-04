import type { GoalDto, GoalMeasure, GoalStatus, PersonRef } from '@teamtrack/shared';
import type { IGoal } from '../../models/Goal';
import type { IUser } from '../../models/User';
import { keyRange } from './period';

/* Progress rules and the explicit DTO mapper (the API never serialises raw documents). */

type ProgressInput = Pick<IGoal, 'keyResults' | 'measure' | 'target' | 'current' | 'tasks'>;

const ratio = (current: number, target: number) => (target > 0 ? Math.min(1, current / target) : 0);

/** 0-100: key results (averaged) if any, else linked tasks for measure=tasks, else current/target. */
export function computeProgress(g: ProgressInput): number {
  if (g.keyResults.length) {
    const sum = g.keyResults.reduce((acc, kr) => acc + ratio(kr.current, kr.target), 0);
    return Math.round((sum / g.keyResults.length) * 100);
  }
  switch (g.measure) {
    case 'tasks':
      return g.tasks.total ? Math.round((g.tasks.done / g.tasks.total) * 100) : 0;
    case 'boolean':
      return g.current >= 1 ? 100 : 0;
    default:
      return Math.round(ratio(g.current, g.target) * 100);
  }
}

/** Fixed targets per measure, and values clamped to what the measure means. */
export function normalizeMeasure(measure: GoalMeasure, target: number, current: number): { measure: GoalMeasure; target: number; current: number } {
  switch (measure) {
    case 'boolean':
      return { measure, target: 1, current: current >= 1 ? 1 : 0 };
    case 'percent':
      return { measure, target: 100, current: Math.min(current, 100) };
    case 'tasks':
      return { measure, target: 1, current: 0 };
    default:
      return { measure, target, current };
  }
}

/**
 * Status follows progress while the period runs: 100% = achieved, otherwise active. After the period
 * ends the rollover job decides; closed statuses (missed, carried over, cancelled) never change here.
 */
export function deriveStatus(g: Pick<IGoal, 'status' | 'periodEnd' | 'closedAt'>, progressPct: number, now: Date): Pick<IGoal, 'status' | 'closedAt'> {
  if ((g.status !== 'active' && g.status !== 'achieved') || now >= g.periodEnd) return { status: g.status, closedAt: g.closedAt };
  const status: GoalStatus = progressPct >= 100 ? 'achieved' : 'active';
  if (status === g.status) return { status, closedAt: g.closedAt };
  return { status, closedAt: status === 'achieved' ? now : null };
}

export const shortTitle = (title: string) => (title.length > 32 ? `${title.slice(0, 31)}…` : title);

const person = (users: Map<string, IUser>, id: IGoal['ownerId']): PersonRef | null => {
  const u = users.get(id.toHexString());
  return u ? { id: u._id.toHexString(), name: u.name } : null;
};

export function toGoalDto(g: IGoal, users: Map<string, IUser>, canEdit: boolean): GoalDto {
  const range = keyRange(g.period, g.periodKey);
  return {
    id: g._id.toHexString(),
    scope: g.scope,
    projectId: g.projectId?.toHexString() ?? null,
    owner: person(users, g.ownerId),
    period: g.period,
    periodKey: g.periodKey,
    startDate: range.start,
    endDate: range.end,
    periodStart: g.periodStart.toISOString(),
    periodEnd: g.periodEnd.toISOString(),
    title: g.title,
    description: g.description,
    measure: g.measure,
    target: g.target,
    current: g.current,
    unit: g.unit,
    keyResults: g.keyResults.map((kr) => ({ id: kr._id.toHexString(), title: kr.title, target: kr.target, current: kr.current, unit: kr.unit })),
    linkedTaskIds: g.linkedTaskIds.map((id) => id.toHexString()),
    tasks: { total: g.tasks.total, done: g.tasks.done },
    progressPct: g.progressPct,
    status: g.status,
    carriedFromId: g.carriedFromId?.toHexString() ?? null,
    carriedToId: g.carriedToId?.toHexString() ?? null,
    parentGoalId: g.parentGoalId?.toHexString() ?? null,
    canEdit,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    version: g.version,
  };
}
