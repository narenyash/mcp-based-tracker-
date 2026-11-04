import { Types } from 'mongoose';
import type { AuthContext } from '../../src/auth/context';
import { boardsService } from '../../src/modules/boards/boards.service';
import type { SeedContext } from './context';

/** Minimal Excalidraw element; the client's restoreElements fills in every other field on load. */
function element(id: string, type: 'rectangle' | 'ellipse' | 'arrow' | 'text', props: Record<string, unknown>) {
  return {
    id,
    type,
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    seed: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    boundElements: null,
    link: null,
    locked: false,
    updated: Date.now(),
    ...props,
  };
}

const text = (id: string, x: number, y: number, value: string, fontSize = 20) =>
  element(id, 'text', { x, y, width: value.length * fontSize * 0.55, height: fontSize * 1.25, text: value, originalText: value, fontSize, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 });

/** Phase 7: one demo whiteboard (a tiny release flow) on the WEB project, saved through the service. */
export async function seedBoards(d: SeedContext): Promise<void> {
  const ctx: AuthContext = { userId: d.users.manager, workspaceId: d.workspaceId, role: 'manager', sessionId: new Types.ObjectId() };
  const board = await boardsService.create(ctx, { projectId: d.projectId.toHexString(), title: 'Release flow' });
  const box = (id: string, x: number, label: string, color: string) => [
    element(id, 'rectangle', { x, y: 120, width: 180, height: 80, backgroundColor: color, roundness: { type: 3 } }),
    text(`${id}-label`, x + 24, 148, label),
  ];
  const arrow = (id: string, x: number) => element(id, 'arrow', { x, y: 160, width: 60, height: 0, points: [[0, 0], [60, 0]], roundness: { type: 2 }, startArrowhead: null, endArrowhead: 'arrow' });
  await boardsService.saveScene(ctx, board.id, {
    elements: [
      text('title', 40, 40, 'Release flow', 28),
      ...box('build', 40, 'Build', '#a5d8ff'),
      arrow('a1', 230),
      ...box('test', 300, 'Test', '#ffec99'),
      arrow('a2', 490),
      ...box('ship', 560, 'Ship', '#b2f2bb'),
      element('note', 'ellipse', { x: 300, y: 260, width: 180, height: 70, strokeStyle: 'dashed' }),
      text('note-label', 330, 284, 'QA sign-off', 16),
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    baseVersion: 0,
    reason: 'manual',
  });
}
