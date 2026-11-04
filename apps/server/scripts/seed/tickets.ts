import { SEVERITY_RANK, type TicketResolution, type TicketSeverity, type TicketType } from '@teamtrack/shared';
import type { Types } from 'mongoose';
import { withTransaction } from '../../src/db/transaction';
import { evenRanks } from '../../src/db/rank';
import { Counter } from '../../src/models';
import { Ticket } from '../../src/models/Ticket';
import { DEFAULT_TICKET_STATUSES } from '../../src/models/Project';
import type { SeedContext } from './context';

/** Phase 4: a handful of demo tickets on the WEB project, one linked to a demo task. */
export async function seedTickets(d: SeedContext): Promise<void> {
  const { manager, member, admin, owner } = d.users;
  const demo: {
    title: string;
    type: TicketType;
    severity: TicketSeverity;
    status: string;
    reporter: Types.ObjectId;
    assignee?: Types.ObjectId;
    resolution?: TicketResolution;
    env?: { browser?: string; os?: string; url?: string };
    steps?: string;
    expected?: string;
    actual?: string;
    linked?: Types.ObjectId[];
  }[] = [
    {
      title: 'Footer links return 404 on mobile',
      type: 'bug',
      severity: 'high',
      status: 'in_progress',
      reporter: owner,
      assignee: member,
      env: { browser: 'Safari 18', os: 'iOS 18', url: 'https://example.com/pricing' },
      steps: '1. Open the site on a phone\n2. Scroll to the footer\n3. Tap "Careers"',
      expected: 'The careers page opens',
      actual: '404 page',
      linked: d.taskIds[2] ? [d.taskIds[2]] : [],
    },
    { title: 'Contact form accepts empty email', type: 'bug', severity: 'medium', status: 'triaged', reporter: admin, assignee: member },
    { title: 'Add an invoice download to the portal', type: 'request', severity: 'low', status: 'open', reporter: manager },
    { title: 'Checkout times out during peak hours', type: 'incident', severity: 'critical', status: 'open', reporter: owner, env: { url: 'https://example.com/checkout' } },
    { title: 'How do I change the billing email?', type: 'question', severity: 'low', status: 'resolved', reporter: admin, assignee: manager, resolution: 'by_design' },
  ];

  const ranks = new Map<string, string[]>();
  for (const s of DEFAULT_TICKET_STATUSES) ranks.set(s.id, evenRanks(demo.filter((t) => t.status === s.id).length));
  const now = new Date();

  await withTransaction(async (session) => {
    await Ticket.create(
      demo.map((t, i) => {
        const status = DEFAULT_TICKET_STATUSES.find((s) => s.id === t.status)!;
        return {
          workspaceId: d.workspaceId,
          projectId: d.projectId,
          number: i + 1,
          key: `TCK-${i + 1}`,
          title: t.title,
          type: t.type,
          severity: t.severity,
          severityRank: SEVERITY_RANK[t.severity],
          statusId: status.id,
          statusCategory: status.category,
          assigneeId: t.assignee ?? null,
          reporterId: t.reporter,
          environment: { browser: '', os: '', url: '', version: '', ...t.env },
          stepsToReproduce: t.steps ?? '',
          expected: t.expected ?? '',
          actual: t.actual ?? '',
          resolution: t.resolution ?? null,
          resolvedAt: t.resolution ? now : null,
          resolvedBy: t.resolution ? (t.assignee ?? manager) : null,
          linkedTaskIds: t.linked ?? [],
          rank: ranks.get(status.id)!.shift()!,
          createdBy: t.reporter,
        };
      }),
      { session, ordered: true },
    );
    await Counter.create([{ _id: `${d.workspaceId.toHexString()}:ticket`, workspaceId: d.workspaceId, seq: demo.length }], { session });
  });
}
