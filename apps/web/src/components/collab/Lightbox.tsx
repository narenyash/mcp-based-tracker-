import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, Trash2, X } from 'lucide-react';
import type { AttachmentDto } from '@teamtrack/shared';
import { formatBytes, fullDate } from '../../lib/collab';

/** Full-screen image viewer on a native <dialog> (focus trap, Esc to close). Arrow keys step through images. */
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  onDelete,
}: {
  images: AttachmentDto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (a: AttachmentDto) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const image = images[index];
  const count = images.length;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  if (!image) return null;
  const step = (by: number) => onIndex((index + by + count) % count);

  return (
    <dialog
      ref={ref}
      aria-label={`Image ${index + 1} of ${count}: ${image.fileName}`}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (count < 2) return;
        if (e.key === 'ArrowRight') step(1);
        if (e.key === 'ArrowLeft') step(-1);
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-black/85 p-0 text-white backdrop:bg-transparent"
    >
      <div className="flex h-full flex-col" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <header className="flex h-12 shrink-0 items-center gap-3 px-4 text-sm">
          <span className="min-w-0 truncate font-medium">{image.fileName}</span>
          <span className="shrink-0 text-xs text-white/60">
            {formatBytes(image.sizeBytes)}
            {image.image && ` · ${image.image.width}×${image.image.height}`}
            {image.uploader && ` · ${image.uploader.name}, ${fullDate(image.createdAt)}`}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {count > 1 && (
              <span className="mr-2 text-xs text-white/60 tabular-nums">
                {index + 1} / {count}
              </span>
            )}
            <a href={image.downloadUrl} download={image.fileName} className="rounded p-1.5 hover:bg-white/10" aria-label="Download" title="Download">
              <Download className="size-4" />
            </a>
            {image.canDelete && (
              <button onClick={() => onDelete(image)} className="rounded p-1.5 hover:bg-white/10 hover:text-red-300" aria-label="Delete image" title="Delete">
                <Trash2 className="size-4" />
              </button>
            )}
            <button onClick={onClose} className="rounded p-1.5 hover:bg-white/10" aria-label="Close" autoFocus>
              <X className="size-4" />
            </button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-6" onClick={(e) => e.target === e.currentTarget && onClose()}>
          <img key={image.id} src={image.url} alt={image.fileName} className="max-h-full max-w-full object-contain" />
          {count > 1 && (
            <>
              <button onClick={() => step(-1)} className="absolute left-3 rounded-full p-2 hover:bg-white/10" aria-label="Previous image">
                <ChevronLeft className="size-6" />
              </button>
              <button onClick={() => step(1)} className="absolute right-3 rounded-full p-2 hover:bg-white/10" aria-label="Next image">
                <ChevronRight className="size-6" />
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
