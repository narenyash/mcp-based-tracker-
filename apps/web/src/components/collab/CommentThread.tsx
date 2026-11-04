import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { parseMentions, type CommentDto, type EntityType, type ServerToClientEvents } from '@teamtrack/shared';
import { commentsApi } from '../../api/collab';
import { ck, fullDate, refreshActivity, timeAgo } from '../../lib/collab';
import { errorMessage, problemOf } from '../../lib/errors';
import { useSocketEvent } from '../../lib/realtime';
import { useAuth } from '../../stores/auth';
import { toastError } from '../../stores/toast';
import { Avatar, Button, cx, ErrorNote, Spinner } from '../ui';
import { CommentComposer } from './CommentComposer';

export interface CommentThreadProps {
  entityType: EntityType;
  entityId: string;
  /** Whether the viewer may add to it (from the entity's own permissions). */
  canWrite: boolean;
}

const PAGE_SIZE = 50;

/** Comments with @mentions and one level of replies on any entity. Live-updates via the `comment:changed` socket event. */
export function CommentThread({ entityType, entityId, canWrite }: CommentThreadProps) {
  const qc = useQueryClient();
  const entity = { entityType, entityId };
  const key = ck.comments(entity);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const thread = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => commentsApi.list({ entityType, entityId }, { cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ck.comments({ entityType, entityId }) });
    refreshActivity(qc, { entityType, entityId });
  }, [qc, entityType, entityId]);

  // Other people's changes arrive over the socket (ours are skipped by the server); refetch through the API.
  const onChanged = useCallback<ServerToClientEvents['comment:changed']>(
    (e) => {
      if (e.entityType === entityType && e.entityId === entityId) refresh();
    },
    [entityType, entityId, refresh],
  );
  useSocketEvent('comment:changed', onChanged);

  const onError = (err: unknown) => {
    if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('This comment changed in the meantime. Showing the latest version.');
      refresh();
    } else toastError(errorMessage(err));
  };

  const create = useMutation({
    mutationFn: (v: { body: string; parentId: string | null }) => commentsApi.create({ entityType, entityId, body: v.body, parentId: v.parentId }),
    onSuccess: refresh,
    onError,
  });
  const update = useMutation({
    mutationFn: (v: { comment: CommentDto; body: string }) => commentsApi.update(v.comment.id, v.body, v.comment.version),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });
  const remove = useMutation({ mutationFn: (c: CommentDto) => commentsApi.remove(c.id), onSuccess: refresh, onError });

  const post = (body: string, parentId: string | null) =>
    create.mutateAsync({ body, parentId }).then(
      () => {
        if (parentId) setReplyTo(null);
        return true;
      },
      () => false,
    );
  const save = (comment: CommentDto, body: string) =>
    update.mutateAsync({ comment, body }).then(
      () => true,
      () => false,
    );

  const all = thread.data?.pages.flatMap((p) => p.items) ?? [];
  const ids = new Set(all.map((c) => c.id));
  // Replies are listed after their parent (oldest first); one whose parent isn't loaded shows at the top level.
  const top = all.filter((c) => !c.parentId || !ids.has(c.parentId));
  const repliesOf = new Map<string, CommentDto[]>();
  for (const c of all) if (c.parentId && ids.has(c.parentId)) repliesOf.set(c.parentId, [...(repliesOf.get(c.parentId) ?? []), c]);
  const count = all.filter((c) => !c.deleted).length;

  const item = (c: CommentDto, isReply: boolean, children?: ReactNode) => (
    <CommentItem
      key={c.id}
      comment={c}
      editing={editing === c.id}
      canReply={canWrite && !isReply && !c.deleted}
      onReply={() => {
        setEditing(null);
        setReplyTo(replyTo === c.id ? null : c.id);
      }}
      onEdit={() => {
        setReplyTo(null);
        setEditing(c.id);
      }}
      onDelete={() => window.confirm('Delete this comment?') && remove.mutate(c)}
      editor={
        <CommentComposer
          entity={entity}
          initialBody={c.body}
          placeholder="Edit comment"
          submitLabel="Save"
          pending={update.isPending}
          autoFocus
          onSubmit={(body) => save(c, body)}
          onCancel={() => setEditing(null)}
        />
      }
    >
      {children}
    </CommentItem>
  );

  return (
    <section aria-labelledby={`comments-${entityId}`}>
      <h3 id={`comments-${entityId}`} className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
        Comments
        {count > 0 && <span className="text-subtle tabular-nums">{count}</span>}
      </h3>

      {thread.isPending ? (
        <Spinner />
      ) : thread.isError ? (
        <ErrorNote>{errorMessage(thread.error)}</ErrorNote>
      ) : (
        <div className="space-y-4">
          {top.length === 0 && !canWrite && <p className="text-xs text-subtle">No comments yet</p>}
          {top.length > 0 && (
            <ul className="space-y-4">
              {top.map((c) => {
                const replies = repliesOf.get(c.id) ?? [];
                return item(
                  c,
                  false,
                  (replies.length > 0 || replyTo === c.id) && (
                    <div className="mt-3 space-y-3 border-l border-border pl-3">
                      {replies.length > 0 && <ul className="space-y-3">{replies.map((r) => item(r, true))}</ul>}
                      {replyTo === c.id && (
                        <CommentComposer
                          entity={entity}
                          placeholder={`Reply to ${c.author?.name ?? 'comment'}`}
                          submitLabel="Reply"
                          pending={create.isPending}
                          autoFocus
                          onSubmit={(body) => post(body, c.id)}
                          onCancel={() => setReplyTo(null)}
                        />
                      )}
                    </div>
                  ),
                );
              })}
            </ul>
          )}

          {thread.hasNextPage && (
            <Button size="sm" variant="ghost" className="-ml-2.5" loading={thread.isFetchingNextPage} onClick={() => void thread.fetchNextPage()}>
              Show newer comments
            </Button>
          )}

          {canWrite && <CommentComposer entity={entity} placeholder="Write a comment" submitLabel="Comment" pending={create.isPending && !replyTo} onSubmit={(body) => post(body, null)} />}
        </div>
      )}
    </section>
  );
}

function CommentItem({
  comment: c,
  editing,
  canReply,
  onReply,
  onEdit,
  onDelete,
  editor,
  children,
}: {
  comment: CommentDto;
  editing: boolean;
  canReply: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  editor: ReactNode;
  children?: ReactNode;
}) {
  const actions = [
    canReply && { label: 'Reply', onClick: onReply },
    c.canEdit && !editing && { label: 'Edit', onClick: onEdit },
    c.canDelete && { label: 'Delete', onClick: onDelete, danger: true },
  ].filter((a): a is { label: string; onClick: () => void; danger?: boolean } => !!a);

  return (
    <li className="flex gap-2.5">
      {c.author ? <Avatar name={c.author.name} size={24} /> : <span aria-hidden className="size-6 shrink-0 rounded-full border border-dashed border-border" />}
      <div className="min-w-0 flex-1">
        {c.deleted ? (
          <p className="py-0.5 text-xs text-subtle">This comment was deleted</p>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{c.author?.name ?? 'Unknown'}</span>
              <time dateTime={c.createdAt} title={fullDate(c.createdAt)} className="text-subtle">
                {timeAgo(c.createdAt)}
              </time>
              {c.editedAt && (
                <span className="text-subtle" title={`Edited ${fullDate(c.editedAt)}`}>
                  (edited)
                </span>
              )}
            </p>
            {editing ? <div className="mt-1.5">{editor}</div> : <CommentBody body={c.body} />}
            {actions.length > 0 && !editing && (
              <div className="mt-1 flex gap-3">
                {actions.map((a) => (
                  <button key={a.label} type="button" onClick={a.onClick} className={cx('text-xs text-subtle', a.danger ? 'hover:text-danger' : 'hover:text-fg')}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {children}
      </div>
    </li>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Plain text with mention chips and clickable links. Rendered as React text nodes, never as HTML. */
function CommentBody({ body }: { body: string }) {
  const me = useAuth((s) => s.user?.id);
  return (
    <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">
      {parseMentions(body).map((s, i) =>
        s.kind === 'mention' ? (
          <span key={i} className={cx('font-medium', s.userId === me && 'rounded bg-hover px-0.5')}>
            @{s.name}
          </span>
        ) : (
          <Fragment key={i}>
            {s.text.split(URL_RE).map((part, j) =>
              j % 2 === 1 ? (
                <a key={j} href={part} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2 hover:text-muted">
                  {part}
                </a>
              ) : (
                part
              ),
            )}
          </Fragment>
        ),
      )}
    </p>
  );
}
