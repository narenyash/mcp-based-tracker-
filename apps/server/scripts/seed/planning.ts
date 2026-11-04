import { Workspace } from '../../src/models';
import { Standup } from '../../src/models/Standup';
import { addDays, keyToDate, localNow } from '../../src/modules/planning/time';
import type { SeedContext } from './context';

/** Phase 8: a few standups for yesterday and today, so the team feed isn't empty (the owner hasn't posted). */
export async function seedPlanning(d: SeedContext): Promise<void> {
  const ws = await Workspace.findById(d.workspaceId, { timezone: 1 }).lean<{ timezone: string }>();
  const today = localNow(ws?.timezone ?? 'UTC').dateKey;
  const yesterday = addDays(today, -1);
  const checkout = d.taskIds[4];
  const entry = (userId: typeof d.users.owner, dateKey: string, body: { yesterday: string; today: string; blockers?: string; blockerTaskIds?: typeof d.taskIds; mood?: number }) => ({
    workspaceId: d.workspaceId,
    userId,
    projectId: d.projectId,
    dateKey,
    date: keyToDate(dateKey),
    blockers: '',
    blockerTaskIds: [],
    mood: null,
    createdBy: userId,
    updatedBy: userId,
    ...body,
  });

  await Standup.create(
    [
      entry(d.users.member, yesterday, { yesterday: 'Set up analytics events.', today: 'Footer links and contact form validation.', mood: 4 }),
      entry(d.users.member, today, {
        yesterday: 'Fixed most footer links; contact form validation is in review.',
        today: 'Finish the footer, then pick up checkout feedback.',
        blockers: 'Waiting on test results for annual checkout.',
        blockerTaskIds: checkout ? [checkout] : [],
        mood: 3,
      }),
      entry(d.users.manager, today, {
        yesterday: 'Reviewed the contact form.',
        today: 'Plan the pricing page redesign.',
        mood: 5,
      }),
      entry(d.users.admin, yesterday, { yesterday: 'Prepared test cases for checkout.', today: 'Test annual plans with card and UPI.' }),
    ],
    { ordered: true },
  );
}
