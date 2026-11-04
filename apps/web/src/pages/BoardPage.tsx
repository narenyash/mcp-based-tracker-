import { lazy, Suspense, useCallback, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History, MessageSquare, MoreHorizontal, PanelRightClose } from 'lucide-react';
import type { BoardPresence, WhiteboardDetailDto } from '@teamtrack/shared';
import { boardsApi } from '../api/boards';
import type { BoardCanvasHandle, SaveStatus } from '../components/board/BoardCanvas';
import { DeleteBoardDialog, RenameBoardDialog } from '../components/board/BoardDialogs';
import { HistoryPanel } from '../components/board/HistoryPanel';
import { CommentThread } from '../components/collab/CommentThread';
import { Avatar, Badge, Button, ErrorNote, Spinner, cx } from '../components/ui';
import { bk, colorFor, usePrefersDark } from '../lib/boards';
import { errorMessage } from '../lib/errors';
import { useProjectRoom } from '../lib/realtime';
import { toast } from '../stores/toast';

// Excalidraw is large: it loads only when a board is opened.
const BoardCanvas = lazy(() => import('../components/board/BoardCanvas'));

type Panel = 'discussion' | 'history' | null;

const STATUS_LABEL: Record<SaveStatus, string> = { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Not saved' };

/** Phase 7: one whiteboard (Excalidraw) with live cursors and a discussion panel. */
export function BoardPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: bk.board(id),
    queryFn: () => boardsApi.get(id),
    // The canvas owns the scene once loaded; refetching would only fight with it.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  // Comments are broadcast to the board's project room; join it so the discussion updates live.
  useProjectRoom(q.data?.projectId ?? '');

  return (
    // Bleed out of the shell's padding and fill the viewport (minus the mobile header).
    <div className="-mx-4 -my-8 flex h-[calc(100dvh-3rem)] flex-col sm:-mx-8 md:h-dvh">
      {q.isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : q.isError ? (
        <div className="space-y-3 p-8">
          <ErrorNote>{errorMessage(q.error)}</ErrorNote>
          <Link to="/boards" className="text-sm text-muted hover:text-fg">
            ← All whiteboards
          </Link>
        </div>
      ) : (
        <Board key={q.data.id} board={q.data} />
      )}
    </div>
  );
}

function Board({ board }: { board: WhiteboardDetailDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dark = usePrefersDark();
  const canvas = useRef<BoardCanvasHandle>(null);
  const [panel, setPanel] = useState<Panel>(() => (window.innerWidth >= 1024 ? 'discussion' : null));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [presence, setPresence] = useState<BoardPresence['users']>([]);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onSaved = useCallback(() => {
    void qc.invalidateQueries({ queryKey: bk.snapshots(board.id) });
    void qc.invalidateQueries({ queryKey: bk.lists });
  }, [qc, board.id]);

  const onRestored = useCallback(
    (detail: WhiteboardDetailDto) => {
      canvas.current?.applyDetail(detail);
      void qc.invalidateQueries({ queryKey: bk.lists });
      toast('Version restored');
    },
    [qc],
  );

  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <Link to="/boards" className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="All whiteboards" title="All whiteboards">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 className="truncate text-sm font-medium">{board.title}</h1>
          <span className="hidden truncate text-xs text-muted sm:inline">{board.projectName}</span>
          {!board.canEdit && <Badge>View only</Badge>}
          {board.canEdit && (
            <span className={cx('hidden shrink-0 text-xs sm:inline', status === 'error' ? 'text-danger' : 'text-subtle')} aria-live="polite">
              {STATUS_LABEL[status]}
            </span>
          )}
        </div>

        <ul className="flex items-center -space-x-1.5" aria-label="People on this board">
          {presence.slice(0, 5).map((u) => (
            <li key={u.id} title={u.name} className="rounded-full ring-2" style={{ ['--tw-ring-color' as string]: colorFor(u.id) }}>
              <Avatar name={u.name} size={24} />
            </li>
          ))}
          {presence.length > 5 && <li className="pl-2.5 text-xs text-muted">+{presence.length - 5}</li>}
        </ul>

        <div className="flex items-center gap-1">
          <PanelButton active={panel === 'discussion'} onClick={() => toggle('discussion')} label="Discussion">
            <MessageSquare className="size-4" />
          </PanelButton>
          <PanelButton active={panel === 'history'} onClick={() => toggle('history')} label="Version history">
            <History className="size-4" />
          </PanelButton>
          {(board.canEdit || board.canDelete) && (
            <div className="relative">
              <PanelButton active={menu} onClick={() => setMenu((m) => !m)} label="More">
                <MoreHorizontal className="size-4" />
              </PanelButton>
              {menu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                  <div role="menu" className="absolute right-0 z-20 mt-1 w-32 rounded-md border border-border bg-bg py-1 shadow-lg" onClick={() => setMenu(false)}>
                    {board.canEdit && (
                      <button role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-hover" onClick={() => setRenaming(true)}>
                        Rename
                      </button>
                    )}
                    {board.canDelete && (
                      <button role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm text-danger hover:bg-hover" onClick={() => setDeleting(true)}>
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            }
          >
            <div className="absolute inset-0">
              <BoardCanvas
                handleRef={canvas}
                board={board}
                canEdit={board.canEdit}
                dark={dark}
                onPresence={setPresence}
                onStatus={setStatus}
                onSaved={onSaved}
              />
            </div>
          </Suspense>
        </div>

        {panel && (
          <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-border bg-bg sm:static sm:w-80 sm:shrink-0">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pr-1.5 pl-4">
              <h2 className="text-sm font-medium">{panel === 'discussion' ? 'Discussion' : 'Version history'}</h2>
              <button onClick={() => setPanel(null)} className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Close panel">
                <PanelRightClose className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {panel === 'discussion' ? (
                <div className="p-4">
                  <CommentThread entityType="board" entityId={board.id} canWrite={board.canEdit} />
                </div>
              ) : (
                <HistoryPanel
                  boardId={board.id}
                  canEdit={board.canEdit}
                  beforeRestore={() => canvas.current?.flush() ?? Promise.resolve()}
                  onRestored={onRestored}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      <RenameBoardDialog board={renaming ? board : null} onClose={() => setRenaming(false)} />
      <DeleteBoardDialog board={deleting ? board : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/boards')} />
    </>
  );
}

function PanelButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label={label} aria-pressed={active} title={label} className={cx('px-2', active && 'bg-hover text-fg')}>
      {children}
    </Button>
  );
}
