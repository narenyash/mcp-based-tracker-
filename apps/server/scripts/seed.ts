/** Dev-only demo data. Idempotent: skips if the demo workspace already exists. */
import { pathToFileURL } from 'node:url';
import { Types } from 'mongoose';
import { env } from '../src/config/env';
import { connectDb, disconnectDb } from '../src/db/connection';
import { withTransaction } from '../src/db/transaction';
import { hashPassword } from '../src/auth/password';
import { Workspace, User, Project, ProjectMember, Task, Label, Counter } from '../src/models';
import { PRIORITY_RANK, type TaskPriority } from '@teamtrack/shared';
import { evenRanks } from '../src/db/rank';
import { DEFAULT_TASK_STATUSES, DEFAULT_TICKET_STATUSES } from '../src/models/Project';
import { logger } from '../src/observability/logger';
import type { SeedContext } from './seed/context';
import { seedTickets } from './seed/tickets';
import { seedCollab } from './seed/collab';
import { seedGoals } from './seed/goals';
import { seedBoards } from './seed/boards';
import { seedPlanning } from './seed/planning';

export const DEMO_PASSWORD = 'password1234';

/** Expects an open connection. */
export async function seedDemo(): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('refusing to seed a production database');
  if (await Workspace.exists({ slug: 'demo' })) {
    logger.info('demo workspace already exists; nothing to do');
    return;
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  let ctx: SeedContext | undefined;
  await withTransaction(async (session) => {
    const wsId = new Types.ObjectId();
    const people = [
      { name: 'Olivia Owner', email: 'owner@demo.test', role: 'owner' },
      { name: 'Arjun Admin', email: 'admin@demo.test', role: 'admin' },
      { name: 'Maya Manager', email: 'manager@demo.test', role: 'manager' },
      { name: 'Sam Member', email: 'member@demo.test', role: 'member' },
    ] as const;
    const users = people.map((p) => ({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      ...p,
      status: 'active',
      passwordHash,
      passwordChangedAt: new Date(),
    }));
    await Workspace.create([{ _id: wsId, name: 'Demo', slug: 'demo', ownerId: users[0]!._id }], { session });
    await User.create(users, { session, ordered: true });

    const lead = users[2]!;
    const projectId = new Types.ObjectId();
    await Project.create(
      [
        {
          _id: projectId,
          workspaceId: wsId,
          key: 'WEB',
          name: 'Website',
          description: 'Marketing site and customer portal',
          leadId: lead._id,
          memberCount: 3,
          workflow: { taskStatuses: DEFAULT_TASK_STATUSES, ticketStatuses: DEFAULT_TICKET_STATUSES },
          createdBy: lead._id,
        },
      ],
      { session },
    );
    await ProjectMember.create(
      [
        { workspaceId: wsId, projectId, userId: lead._id, role: 'lead' },
        { workspaceId: wsId, projectId, userId: users[3]!._id, role: 'member' },
        { workspaceId: wsId, projectId, userId: users[1]!._id, role: 'member' },
      ],
      { session, ordered: true },
    );

    const labels = await Label.create(
      [
        { workspaceId: wsId, projectId, name: 'Bug', color: '#dc2626' },
        { workspaceId: wsId, projectId, name: 'Design', color: '#7c3aed' },
      ],
      { session, ordered: true },
    );
    const [bug, design] = [labels[0]!._id, labels[1]!._id];
    const sam = users[3]!._id;
    const arjun = users[1]!._id;
    const now = new Date();
    const day = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
    const demo: { title: string; status: string; category: string; priority: TaskPriority; assignee?: typeof sam; tester?: typeof sam; labels?: (typeof bug)[]; due?: Date }[] = [
      { title: 'Redesign the pricing page', status: 'todo', category: 'todo', priority: 'medium', labels: [design], due: day(7) },
      { title: 'Add cookie consent banner', status: 'todo', category: 'todo', priority: 'low' },
      { title: 'Fix broken links in footer', status: 'in_progress', category: 'in_progress', priority: 'high', assignee: sam, labels: [bug], due: day(2) },
      { title: 'Contact form validation', status: 'review', category: 'in_progress', priority: 'medium', assignee: sam },
      { title: 'Checkout flow for annual plans', status: 'testing', category: 'testing', priority: 'urgent', assignee: sam, tester: arjun, due: day(1) },
      { title: 'Set up analytics', status: 'done', category: 'done', priority: 'none', assignee: sam },
    ];
    const ranks = evenRanks(demo.length);
    const taskIds = demo.map(() => new Types.ObjectId());
    await Task.create(
      demo.map((t, i) => ({
        _id: taskIds[i],
        workspaceId: wsId,
        projectId,
        number: i + 1,
        key: `WEB-${i + 1}`,
        title: t.title,
        statusId: t.status,
        statusCategory: t.category,
        priority: t.priority,
        priorityRank: PRIORITY_RANK[t.priority],
        assigneeId: t.assignee ?? null,
        testerId: t.tester ?? null,
        reporterId: lead._id,
        labelIds: t.labels ?? [],
        dueDate: t.due ?? null,
        completedAt: t.category === 'done' ? now : null,
        rank: ranks[i],
        testing: t.tester ? { round: 1, result: 'pending', sentAt: now, sentBy: sam, note: 'Try both card and UPI payments.' } : null,
        createdBy: lead._id,
      })),
      { session, ordered: true },
    );
    await Counter.create([{ _id: `${projectId.toHexString()}:task`, workspaceId: wsId, seq: demo.length }], { session });
    ctx = {
      workspaceId: wsId,
      projectId,
      users: { owner: users[0]!._id, admin: arjun, manager: lead._id, member: sam },
      taskIds,
    };
  });
  for (const seed of [seedTickets, seedCollab, seedGoals, seedBoards, seedPlanning]) await seed(ctx!);
  logger.info(`seeded: sign in as owner@demo.test / ${DEMO_PASSWORD} (also admin@, manager@, member@)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await connectDb();
    await seedDemo();
    await disconnectDb();
  } catch (err) {
    logger.fatal({ err }, 'seed failed');
    process.exit(1);
  }
}
