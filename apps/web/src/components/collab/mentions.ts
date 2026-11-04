import { mentionToken, parseMentions } from '@teamtrack/shared';

/**
 * The composer shows mentions as plain `@Name` and remembers who each name refers to; the stored body uses
 * `@[Name](id)` tokens. These convert between the two.
 */
export type MentionMap = Map<string, string>;

export function toDraft(body: string): { text: string; mentions: MentionMap } {
  const mentions: MentionMap = new Map();
  const text = parseMentions(body)
    .map((s) => {
      if (s.kind === 'text') return s.text;
      mentions.set(s.name, s.userId);
      return `@${s.name}`;
    })
    .join('');
  return { text, mentions };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function fromDraft(text: string, mentions: MentionMap): string {
  const names = [...mentions.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  // Longest names first, so "@Ann Lee" wins over "@Ann"; a name must not run on into more letters.
  const re = new RegExp(`@(${names.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return text.replace(re, (_m, name: string) => mentionToken(name, mentions.get(name)!));
}

/** The `@query` being typed just before the caret, if any. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@[\]()]{0,40})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}
