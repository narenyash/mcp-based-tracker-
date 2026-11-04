import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ListPlus } from 'lucide-react';
import { STANDUP_TEXT_MAX, type StandupDto, type StandupSuggestionsDto, type StandupTaskRefDto } from '@teamtrack/shared';
import { standupsApi } from '../../api/planning';
import { errorMessage, problemOf, serverFieldErrors } from '../../lib/errors';
import { planningKeys } from '../../lib/planning';
import { toastError } from '../../stores/toast';
import { Button, Field, Textarea } from '../ui';
import { BlockerPicker } from './BlockerPicker';
import { MoodPicker } from './MoodPicker';

interface Draft {
  yesterday: string;
  today: string;
  blockers: string;
  mood: number | null;
  blockerTasks: StandupTaskRefDto[];
}

const fromEntry = (s: StandupDto | null): Draft => ({
  yesterday: s?.yesterday ?? '',
  today: s?.today ?? '',
  blockers: s?.blockers ?? '',
  mood: s?.mood ?? null,
  blockerTasks: s?.blockerTasks ?? [],
});

/** Appends "- KEY title" lines for tasks not already mentioned. */
function withTasks(text: string, tasks: StandupTaskRefDto[]): string {
  const lines = tasks.filter((t) => !text.includes(t.key)).map((t) => `- ${t.key} ${t.title}`);
  if (!lines.length) return text;
  return [text.trimEnd(), ...lines].filter(Boolean).join('\n').slice(0, STANDUP_TEXT_MAX);
}

/**
 * My standup for one day (today or yesterday). The first save creates it; later saves send the
 * version (If-Match), so an edit from another tab is never silently overwritten.
 */
export function StandupForm({ date, mine, onConflict }: { date: string; mine: StandupDto | null; onConflict: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => fromEntry(mine));
  const [version, setVersion] = useState<number | undefined>(mine?.version);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilling, setPrefilling] = useState(false);

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  };

  const save = useMutation({
    mutationFn: () =>
      standupsApi.saveMine(
        { date, yesterday: draft.yesterday, today: draft.today, blockers: draft.blockers, mood: draft.mood, blockerTaskIds: draft.blockerTasks.map((t) => t.id) },
        version,
      ),
    onSuccess: (s) => {
      setVersion(s.version);
      setDraft(fromEntry(s));
      setSaved(true);
      setErrors({});
      void qc.invalidateQueries({ queryKey: planningKeys.standups });
    },
    onError: (err) => {
      const status = problemOf(err)?.status;
      if (status === 409 || status === 428) {
        toastError('Your standup was changed in another tab. Showing the latest version.');
        onConflict();
        return;
      }
      setErrors(serverFieldErrors(err));
      toastError(errorMessage(err));
    },
  });

  const prefill = async () => {
    setPrefilling(true);
    try {
      const s: StandupSuggestionsDto = await qc.fetchQuery({ queryKey: planningKeys.suggestions, queryFn: standupsApi.suggestions, staleTime: 30_000 });
      if (!s.completed.length && !s.inProgress.length) toastError('Nothing to suggest: no tasks finished since the last working day or in progress.');
      edit({ yesterday: withTasks(draft.yesterday, s.completed), today: withTasks(draft.today, s.inProgress) });
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setPrefilling(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const text = (key: 'yesterday' | 'today' | 'blockers', label: string, placeholder: string) => (
    <Field label={label} error={errors[key]}>
      {(id) => (
        <Textarea
          id={id}
          value={draft[key]}
          onChange={(e) => edit({ [key]: e.target.value })}
          maxLength={STANDUP_TEXT_MAX}
          placeholder={placeholder}
          className="min-h-16"
        />
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4">
      {text('yesterday', 'Yesterday', 'What did you get done?')}
      {text('today', 'Today', 'What are you working on today?')}
      {text('blockers', 'Blockers', 'Anything in your way?')}
      <Field label="Blocking tasks" error={errors.blockerTaskIds}>
        {() => <BlockerPicker value={draft.blockerTasks} onChange={(blockerTasks) => edit({ blockerTasks })} />}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <MoodPicker value={draft.mood} onChange={(mood) => edit({ mood })} />
        <Button type="button" size="sm" variant="ghost" onClick={() => void prefill()} loading={prefilling} title="Fill in from tasks you finished and are working on">
          {!prefilling && <ListPlus className="size-3.5" strokeWidth={1.5} />}
          Prefill from my tasks
        </Button>
        <span className="ml-auto flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-muted" role="status">
              <Check className="size-3.5" /> Saved
            </span>
          )}
          <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
            {version === undefined ? 'Post standup' : 'Save'}
          </Button>
        </span>
      </div>
    </form>
  );
}
