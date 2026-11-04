import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MAX_COMMENT_LENGTH, type EntityRef, type MentionableUserDto } from '@teamtrack/shared';
import { commentsApi } from '../../api/collab';
import { ck } from '../../lib/collab';
import { useDebounced } from '../../lib/hooks';
import { Avatar, Button, cx, Spinner } from '../ui';
import { activeMentionQuery, fromDraft, toDraft, type MentionMap } from './mentions';

/** Textarea with @mention autocomplete. Submits with the button or Ctrl/Cmd+Enter. */
export function CommentComposer({
  entity,
  initialBody = '',
  placeholder,
  submitLabel,
  pending,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  entity: EntityRef;
  initialBody?: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  autoFocus?: boolean;
  /** Resolves true when saved, so the composer can clear itself. */
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [initial] = useState(() => toDraft(initialBody));
  const [text, setText] = useState(initial.text);
  const mentions = useRef<MentionMap>(initial.mentions);
  const area = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();

  const q = useDebounced(mention?.query ?? '', 150);
  const people = useQuery({
    queryKey: ck.mentionable(entity, q.toLowerCase()),
    queryFn: () => commentsApi.mentionable(entity, q),
    enabled: mention !== null,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const options = mention ? (people.data ?? []) : [];
  const open = mention !== null && (options.length > 0 || people.isFetching);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (!autoFocus) return;
    const el = area.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const body = fromDraft(text, mentions.current);
  const tooLong = body.length > MAX_COMMENT_LENGTH;
  const canSubmit = text.trim().length > 0 && !tooLong && !pending;

  const track = (el: HTMLTextAreaElement) => {
    setMention(el.selectionStart === el.selectionEnd ? activeMentionQuery(el.value, el.selectionStart) : null);
  };

  const pick = (u: MentionableUserDto) => {
    const el = area.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const insert = `@${u.name} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    mentions.current.set(u.name, u.id);
    setText(next);
    setMention(null);
    const at = mention.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    if (await onSubmit(body)) {
      setText('');
      mentions.current = new Map();
      setMention(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && options.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(options[Math.min(active, options.length - 1)]!);
        return;
      }
    }
    if (e.key === 'Escape' && (open || onCancel)) {
      // Keep Esc from also closing the surrounding drawer.
      e.preventDefault();
      e.stopPropagation();
      if (open) setMention(null);
      else onCancel?.();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="relative">
        <textarea
          ref={area}
          aria-label={placeholder}
          placeholder={placeholder}
          rows={Math.min(12, Math.max(2, text.split('\n').length))}
          value={text}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            track(e.target);
          }}
          onSelect={(e) => track(e.currentTarget)}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          className="w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm placeholder:text-subtle focus:border-fg focus:outline-none disabled:opacity-60"
        />
        {open && (
          <ul id={listId} role="listbox" aria-label="People to mention" className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-bg py-1 shadow-lg">
            {options.length === 0 ? (
              <li className="px-3 py-2">
                <Spinner />
              </li>
            ) : (
              options.map((u, i) => (
                <li
                  key={u.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(u)}
                  className={cx('flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm', i === active && 'bg-hover')}
                >
                  <Avatar name={u.name} size={20} />
                  <span className="truncate">{u.name}</span>
                  <span className="ml-auto truncate text-xs text-subtle">{u.email}</span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={cx('text-2xs', tooLong ? 'text-danger' : 'text-subtle')}>
          {tooLong
            ? `${(body.length - MAX_COMMENT_LENGTH).toLocaleString()} characters over the limit`
            : body.length > MAX_COMMENT_LENGTH * 0.9
              ? `${(MAX_COMMENT_LENGTH - body.length).toLocaleString()} characters left`
              : text
                ? 'Ctrl+Enter to send · @ to mention'
                : ''}
        </span>
        <div className="ml-auto flex gap-1.5">
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" variant="primary" disabled={!canSubmit} loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
