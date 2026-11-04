import { useMutation, useQuery } from '@tanstack/react-query';
import type { WhiteboardDetailDto, WhiteboardSnapshotDto } from '@teamtrack/shared';
import { boardsApi } from '../../api/boards';
import { bk, formatBytes, timeAgo } from '../../lib/boards';
import { errorMessage } from '../../lib/errors';
import { Badge, Button, ErrorNote, Spinner } from '../ui';

const REASON: Record<WhiteboardSnapshotDto['reason'], string> = { autosave: 'Autosave', manual: 'Saved', restore: 'Restored' };

/** Saved versions of a board, newest first, with restore. */
export function HistoryPanel({
  boardId,
  canEdit,
  beforeRestore,
  onRestored,
}: {
  boardId: string;
  canEdit: boolean;
  /** Lets the canvas save pending edits first, so they appear in history and aren't lost. */
  beforeRestore: () => Promise<void>;
  onRestored: (detail: WhiteboardDetailDto) => void;
}) {
  const q = useQuery({ queryKey: bk.snapshots(boardId), queryFn: () => boardsApi.snapshots(boardId) });
  const restore = useMutation({
    mutationFn: async (snapshotId: string) => {
      await beforeRestore();
      return boardsApi.restore(boardId, snapshotId);
    },
    onSuccess: (detail) => {
      onRestored(detail);
      void q.refetch();
    },
  });

  if (q.isPending) return <Spinner className="m-4" />;
  if (q.isError) return <ErrorNote>{errorMessage(q.error)}</ErrorNote>;
  if (!q.data.length) return <p className="p-4 text-sm text-muted">No saved versions yet. Changes are saved automatically as you draw.</p>;

  return (
    <div>
      {restore.isError && (
        <div className="p-3">
          <ErrorNote>{errorMessage(restore.error)}</ErrorNote>
        </div>
      )}
      <ul className="divide-y divide-border">
        {q.data.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm">
                <span className="font-medium">v{s.sceneVersion}</span>
                <span className="text-xs text-muted">{REASON[s.reason]}</span>
                {s.current && <Badge>Current</Badge>}
              </p>
              <p className="mt-0.5 truncate text-xs text-subtle" title={new Date(s.createdAt).toLocaleString()}>
                {timeAgo(s.createdAt)}
                {s.createdBy && ` · ${s.createdBy.name}`} · {s.elementCount} {s.elementCount === 1 ? 'element' : 'elements'} · {formatBytes(s.sizeBytes)}
              </p>
            </div>
            {canEdit && !s.current && (
              <Button
                size="sm"
                variant="ghost"
                loading={restore.isPending && restore.variables === s.id}
                disabled={restore.isPending}
                onClick={() => {
                  if (window.confirm(`Restore version ${s.sceneVersion}? The current drawing stays in history.`)) restore.mutate(s.id);
                }}
              >
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
