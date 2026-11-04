import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Trash2, Upload, X } from 'lucide-react';
import { MAX_ATTACHMENTS_PER_ENTITY, type AttachmentDto, type EntityType } from '@teamtrack/shared';
import { attachmentsApi } from '../../api/collab';
import { ACCEPT_ATTR, ck, formatBytes, fullDate, isImageMime, namePastedFile, refreshActivity, rejectFile, timeAgo } from '../../lib/collab';
import { errorMessage } from '../../lib/errors';
import { toast, toastError } from '../../stores/toast';
import { Button, cx, ErrorNote, Spinner } from '../ui';
import { Lightbox } from './Lightbox';

export interface AttachmentsProps {
  entityType: EntityType;
  entityId: string;
  /** Whether the viewer may add to it (from the entity's own permissions). */
  canWrite: boolean;
}

/** Signed URLs live 5 minutes; refetch a little before that while the panel is open. */
const URL_REFRESH_MS = 4 * 60_000;

interface Pending {
  id: number;
  name: string;
  progress: number;
}

let nextPendingId = 1;

/** Image/file attachments on any entity: upload (drag, paste, pick), gallery, lightbox, delete. */
export function Attachments({ entityType, entityId, canWrite }: AttachmentsProps) {
  const qc = useQueryClient();
  const ref = { entityType, entityId };
  const key = ck.attachments(ref);
  const list = useQuery({
    queryKey: key,
    queryFn: () => attachmentsApi.list({ entityType, entityId }),
    staleTime: URL_REFRESH_MS,
    refetchInterval: URL_REFRESH_MS,
  });
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);

  const items = list.data ?? [];
  const images = items.filter((a) => isImageMime(a.mimeType));
  const files = items.filter((a) => !isImageMime(a.mimeType));

  const remove = useMutation({
    mutationFn: (a: AttachmentDto) => attachmentsApi.remove(a.id),
    onSuccess: (_r, a) => {
      qc.setQueryData<AttachmentDto[]>(key, (prev) => prev?.filter((x) => x.id !== a.id));
      refreshActivity(qc, ref);
      toast(`Removed ${a.fileName}`);
    },
    onError: (err) => toastError(errorMessage(err)),
  });
  const confirmRemove = (a: AttachmentDto) => {
    if (!window.confirm(`Remove ${a.fileName}?`)) return;
    if (viewing !== null) {
      const left = images.filter((x) => x.id !== a.id).length;
      setViewing(left === 0 ? null : Math.min(viewing, left - 1));
    }
    remove.mutate(a);
  };

  // Kept in a ref so the paste listener below doesn't resubscribe on every render.
  const addFilesRef = useRef<(list: File[]) => void>(() => undefined);
  addFilesRef.current = (incoming: File[]) => {
    if (!canWrite || incoming.length === 0) return;
    const room = MAX_ATTACHMENTS_PER_ENTITY - items.length - pending.length;
    const accepted: File[] = [];
    for (const f of incoming) {
      const reason = rejectFile(f);
      if (reason) toastError(reason);
      else accepted.push(f);
    }
    if (accepted.length > room) {
      toastError(room <= 0 ? `This item already has ${MAX_ATTACHMENTS_PER_ENTITY} attachments. Remove one to add another.` : `Only ${room} more file${room === 1 ? '' : 's'} can be attached here.`);
      accepted.splice(Math.max(0, room));
    }
    for (const file of accepted) void upload(file);
  };

  async function upload(file: File) {
    const id = nextPendingId++;
    setPending((p) => [...p, { id, name: file.name, progress: 0 }]);
    try {
      const created = await attachmentsApi.upload({ entityType, entityId }, file, (progress) =>
        setPending((p) => p.map((x) => (x.id === id ? { ...x, progress } : x))),
      );
      qc.setQueryData<AttachmentDto[]>(key, (prev) => (prev ? [...prev.filter((x) => x.id !== created.id), created] : [created]));
      refreshActivity(qc, { entityType, entityId });
    } catch (err) {
      toastError(`${file.name}: ${errorMessage(err)}`);
    } finally {
      setPending((p) => p.filter((x) => x.id !== id));
    }
  }

  // Paste a screenshot anywhere in the surrounding drawer (or page, outside dialogs) to attach it.
  useEffect(() => {
    if (!canWrite) return;
    const onPaste = (e: ClipboardEvent) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (!pasted.length || !root.current) return;
      const scope = root.current.closest('dialog');
      const target = e.target instanceof Node ? e.target : null;
      if (scope ? !target || !scope.contains(target) : document.querySelector('dialog[open]')) return;
      // Copying from office apps puts an image of the text on the clipboard too; in a text field, keep the text.
      const editable = target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
      if (editable && e.clipboardData?.types.includes('text/plain')) return;
      e.preventDefault();
      addFilesRef.current(pasted.map(namePastedFile));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canWrite]);

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const dropProps = canWrite
    ? {
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          addFilesRef.current([...e.dataTransfer.files]);
        },
      }
    : {};

  if (!canWrite && !list.isPending && items.length === 0) return null;
  const empty = items.length === 0 && pending.length === 0;
  const browse = () => input.current?.click();

  return (
    <section ref={root} aria-labelledby={`attachments-${entityId}`} {...dropProps} className={cx('relative rounded-md', dragging && 'outline-2 outline-offset-4 outline-fg outline-dashed')}>
      <div className="mb-2 flex items-center gap-2">
        <h3 id={`attachments-${entityId}`} className="text-xs font-medium text-muted">
          Attachments
        </h3>
        {items.length > 0 && <span className="text-xs text-subtle tabular-nums">{items.length}</span>}
        {canWrite && !empty && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={browse} disabled={items.length + pending.length >= MAX_ATTACHMENTS_PER_ENTITY}>
            <Paperclip className="size-3.5" />
            Attach
          </Button>
        )}
      </div>
      {canWrite && (
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose files to attach"
          onChange={(e) => {
            addFilesRef.current([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      )}

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNote>{errorMessage(list.error)}</ErrorNote>
      ) : (
        <div className="space-y-2">
          {empty && canWrite && (
            <button
              type="button"
              onClick={browse}
              className={cx(
                'flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted hover:bg-hover hover:text-fg',
                dragging && 'bg-hover text-fg',
              )}
            >
              <Upload className="size-3.5" />
              Drop files, paste a screenshot, or <span className="underline underline-offset-2">browse</span>
            </button>
          )}

          {images.length > 0 && (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {images.map((a, i) => (
                <li key={a.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => setViewing(i)}
                    className="block aspect-square w-full overflow-hidden rounded-md border border-border bg-surface"
                    aria-label={`View ${a.fileName}`}
                    title={a.fileName}
                  >
                    <img src={a.url} alt="" loading="lazy" className="size-full object-cover transition-opacity group-hover:opacity-90" />
                  </button>
                  {a.canDelete && (
                    <button
                      type="button"
                      onClick={() => confirmRemove(a)}
                      className="absolute top-1 right-1 rounded bg-bg/90 p-0.5 text-muted opacity-0 shadow-sm group-hover:opacity-100 hover:text-danger focus:opacity-100"
                      aria-label={`Remove ${a.fileName}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {files.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {files.map((a) => (
                <li key={a.id} className="group flex items-center gap-2.5 px-3 py-2">
                  <FileText className="size-4 shrink-0 text-subtle" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <a href={a.downloadUrl} download={a.fileName} className="block truncate text-sm hover:underline">
                      {a.fileName}
                    </a>
                    <p className="truncate text-2xs text-subtle">
                      {formatBytes(a.sizeBytes)}
                      {a.uploader && ` · ${a.uploader.name}`} ·{' '}
                      <time dateTime={a.createdAt} title={fullDate(a.createdAt)}>
                        {timeAgo(a.createdAt)}
                      </time>
                    </p>
                  </div>
                  {a.mimeType === 'application/pdf' && (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-muted hover:text-fg hover:underline">
                      Open
                    </a>
                  )}
                  {a.canDelete && (
                    <button
                      type="button"
                      onClick={() => confirmRemove(a)}
                      className="shrink-0 rounded p-1 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                      aria-label={`Remove ${a.fileName}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {pending.length > 0 && (
            <ul className="space-y-1.5" aria-live="polite">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center gap-2.5 text-xs text-muted">
                  <Spinner className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span
                    role="progressbar"
                    aria-label={`Uploading ${p.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(p.progress * 100)}
                    className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-hover"
                  >
                    <span className="block h-full bg-fg transition-[width]" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {viewing !== null && images[viewing] && (
        <Lightbox images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} onDelete={confirmRemove} />
      )}
    </section>
  );
}
