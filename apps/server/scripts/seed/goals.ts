import { Types } from 'mongoose';
import { Goal, type IGoal } from '../../src/models/Goal';
import { Task } from '../../src/models/Task';
import { Workspace } from '../../src/models/Workspace';
import { computeProgress } from '../../src/modules/goals/goals.dto';
import { localDay, periodContaining } from '../../src/modules/goals/period';
import type { SeedContext } from './context';

type Seed = Pick<IGoal, 'scope' | 'ownerId' | 'period' | 'title' | 'measure' | 'target' | 'current' | 'unit'> &
  Partial<Pick<IGoal, 'projectId' | 'description' | 'parentGoalId' | 'linkedTaskIds'>> & { _id?: Types.ObjectId; keyResults?: Omit<IGoal['keyResults'][number], '_id'>[] };

/** Phase 6: demo goals for today, this week and this month; one tracks demo tasks. */
export async function seedGoals(d: SeedContext): Promise<void> {
  const ws = await Workspace.findById(d.workspaceId, { timezone: 1 }).lean<{ timezone: string }>();
  const tz = ws?.timezone ?? 'Asia/Kolkata';
  const today = localDay(tz, new Date());
  const { manager, member } = d.users;
  const weekly = new Types.ObjectId();
  const linked = [d.taskIds[2]!, d.taskIds[4]!, d.taskIds[5]!];
  const tasks = await Task.find({ workspaceId: d.workspaceId, _id: { $in: linked } }, { statusCategory: 1 }).lean<{ statusCategory: string }[]>();

  const seeds: Seed[] = [
    {
      _id: weekly,
      scope: 'personal',
      ownerId: member,
      period: 'weekly',
      title: 'Wrap up the website fixes',
      description: 'Footer links, checkout and analytics.',
      measure: 'tasks',
      target: 1,
      current: 0,
      unit: '',
      linkedTaskIds: linked,
    },
    { scope: 'personal', ownerId: member, period: 'daily', title: 'Review 3 pull requests', measure: 'number', target: 3, current: 1, unit: 'PRs', parentGoalId: weekly },
    { scope: 'personal', ownerId: member, period: 'daily', title: 'Reply to the design feedback', measure: 'boolean', target: 1, current: 0, unit: '' },
    {
      scope: 'team',
      ownerId: manager,
      period: 'monthly',
      title: 'Ship the new pricing',
      measure: 'number',
      target: 1,
      current: 0,
      unit: '',
      keyResults: [
        { title: 'Pages redesigned', target: 4, current: 1, unit: 'pages' },
        { title: 'Conversion rate', target: 3, current: 1.2, unit: '%' },
      ],
    },
    { scope: 'project', projectId: d.projectId, ownerId: manager, period: 'weekly', title: 'Website QA pass', measure: 'percent', target: 100, current: 40, unit: '%' },
  ];

  await Goal.create(
    seeds.map(({ keyResults = [], linkedTaskIds = [], ...s }) => {
      const range = periodContaining(s.period, today, tz);
      const goal = {
        ...s,
        workspaceId: d.workspaceId,
        projectId: s.projectId ?? null,
        periodKey: range.key,
        periodStart: range.periodStart,
        periodEnd: range.periodEnd,
        keyResults: keyResults.map((kr) => ({ _id: new Types.ObjectId(), ...kr })),
        linkedTaskIds,
        tasks: linkedTaskIds.length ? { total: tasks.length, done: tasks.filter((t) => t.statusCategory === 'done').length } : { total: 0, done: 0 },
        status: 'active' as const,
        createdBy: s.ownerId,
        updatedBy: s.ownerId,
      };
      return { ...goal, progressPct: computeProgress(goal) };
    }),
    { ordered: true },
  );
}
