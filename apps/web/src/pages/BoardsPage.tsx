import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { MoreHorizontal, PenTool, Plus } from 'lucide-react';
import type { WhiteboardDto } from '@teamtrack/shared';
import { boardsApi } from '../api/boards';
import { CreateBoardDialog, DeleteBoardDialog, RenameBoardDialog } from '../components/board/BoardDialogs';
import { Button, EmptyState, ErrorNote, PageHeader, Select, Spinner } from '../components/ui';
import { bk, timeAgo } from '../lib/boards';
import { errorMessage } from '../lib/errors';
import { useActiveProjects } from '../lib/tickets';

/** Phase 7: grid of whiteboards. */
export function BoardsPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? '';
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WhiteboardDto | null>(null);
  const [deleting, setDeleting] = useState<WhiteboardDto | null>(null);
  const projects = useActiveProjects().data?.items ?? [];

  const listParams = projectId ? { projectId } : {};
  const q = useInfiniteQuery({
    queryKey: bk.list(listParams),
    queryFn: ({ pageParam }) => boardsApi.list({ ...listParams, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const boards = q.data?.pages.flatMap((p) => p.items) ?? [];

  const setProject = (id: string) => setParams(id ? { project: id } : {}, { replace: true });

  return (
    <>
      <PageHeader
        title="Whiteboards"
        description="Sketch ideas together, live"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New board
          </Button>
        }
      />

      <div className="mb-6 flex items-center gap-2">
        <Select aria-label="Project" className="w-56" value={projectId} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote>{errorMessage(q.error)}</ErrorNote>
      ) : boards.length === 0 ? (
        <EmptyState
          title="No whiteboards yet"
          description="Boards are shared canvases for diagrams, flows and rough ideas"
          action={<Button onClick={() => setCreating(true)}>Create a board</Button>}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => (
            <BoardCard key={b.id} board={b} onRename={() => setRenaming(b)} onDelete={() => setDeleting(b)} />
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="mt-6 text-center">
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}

      <CreateBoardDialog open={creating} onClose={() => setCreating(false)} defaultProjectId={projectId || undefined} />
      <RenameBoardDialog board={renaming} onClose={() => setRenaming(null)} />
      <DeleteBoardDialog board={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function BoardCard({ board: b, onRename, onDelete }: { board: WhiteboardDto; onRename: () => void; onDelete: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <li className="group relative overflow-hidden rounded-lg border border-border bg-bg transition-colors hover:border-subtle">
      <Link to={`/boards/${b.id}`} className="block">
        <div className="flex aspect-[16/10] items-center justify-center border-b border-border bg-surface">
          {b.thumbnailUrl && !imgFailed ? (
            // Thumbnails are PNGs on a white background; keep them readable in dark mode too.
            <img src={b.thumbnailUrl} alt="" loading="lazy" onError={() => setImgFailed(true)} className="size-full bg-white object-contain p-2" />
          ) : (
            <PenTool className="size-6 text-subtle" strokeWidth={1.5} />
          )}
        </div>
        <div className="px-3.5 py-3">
          <p className="truncate pr-6 text-sm font-medium">{b.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{b.projectName}</p>
          <p className="mt-1.5 truncate text-xs text-subtle">
            Edited {timeAgo(b.lastEditedAt)}
            {b.lastEditedBy && ` by ${b.lastEditedBy.name}`}
          </p>
        </div>
      </Link>
      {(b.canEdit || b.canDelete) && (
        <CardMenu>
          {b.canEdit && <MenuItem onClick={onRename}>Rename</MenuItem>}
          {b.canDelete && (
            <MenuItem onClick={onDelete} danger>
              Delete
            </MenuItem>
          )}
        </CardMenu>
      )}
    </li>
  );
}

function CardMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={ref} className="absolute top-2 right-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Board actions"
        aria-expanded={open}
        className="rounded border border-border bg-bg p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" onClick={() => setOpen(false)} className="absolute right-0 z-10 mt-1 w-32 rounded-md border border-border bg-bg py-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-hover ${danger ? 'text-danger' : ''}`}>
      {children}
    </button>
  );
}
