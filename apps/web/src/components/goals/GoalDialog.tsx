import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import {
  createGoalSchema,
  GOAL_MEASURES,
  hasRoleAtLeast,
  MAX_KEY_RESULTS,
  updateGoalSchema,
  type GoalDto,
  type GoalMeasure,
  type GoalPeriod,
  type GoalScope,
  type UpdateGoalInput,
} from '@teamtrack/shared';
import { goalsApi } from '../../api/goals';
import { usersApi } from '../../api/endpoints';
import { errorMessage, problemOf, serverFieldErrors, validate, type FieldErrors } from '../../lib/errors';
import { gk, goalPeriodShort, isClosed, MEASURE_LABEL, PARENT_PERIOD, PERIOD_LABEL, PERIOD_NOUN, refreshGoals, syncGoal } from '../../lib/goals';
import { useActiveProjects } from '../../lib/tickets';
import { useAuth } from '../../stores/auth';
import { toast, toastError } from '../../stores/toast';
import { Button, Dialog, ErrorNote, Field, Input, Select, Textarea } from '../ui';

interface KrDraft {
  id?: string;
  title: string;
  target: string;
  current: number;
  unit: string;
}

interface Form {
  title: string;
  description: string;
  scope: GoalScope;
  projectId: string;
  ownerId: string;
  measure: GoalMeasure;
  target: string;
  unit: string;
  keyResults: KrDraft[];
  parentGoalId: string;
}

function initialForm(goal: GoalDto | undefined, myId: string): Form {
  return {
    title: goal?.title ?? '',
    description: goal?.description ?? '',
    scope: goal?.scope ?? 'personal',
    projectId: goal?.projectId ?? '',
    ownerId: goal?.owner?.id ?? myId,
    measure: goal?.measure ?? 'boolean',
    target: goal && goal.measure === 'number' ? String(goal.target) : '',
    unit: goal?.unit ?? '',
    keyResults: goal?.keyResults.map((kr) => ({ id: kr.id, title: kr.title, target: String(kr.target), current: kr.current, unit: kr.unit })) ?? [],
    parentGoalId: goal?.parentGoalId ?? '',
  };
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

/**
 * Create or edit a goal. `date` is any day in the period being viewed, so a goal created while looking at
 * next week lands in next week. Scope, project and period are fixed once created (the server's rule).
 */
export function GoalDialog({
  open,
  onClose,
  period,
  date,
  goal,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  period: GoalPeriod;
  date: string | undefined;
  goal?: GoalDto | undefined;
  onCreated?: (g: GoalDto) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={goal ? 'Edit goal' : `New ${PERIOD_LABEL[period].toLowerCase()} goal`}>
      {/* Keyed so each opening starts from fresh values. */}
      <GoalForm key={goal ? `${goal.id}:${goal.version}` : `new:${period}:${date ?? ''}`} onClose={onClose} period={period} date={date} goal={goal} onCreated={onCreated} />
    </Dialog>
  );
}

function GoalForm({
  onClose,
  period,
  date,
  goal,
  onCreated,
}: {
  onClose: () => void;
  period: GoalPeriod;
  date: string | undefined;
  goal: GoalDto | undefined;
  onCreated: ((g: GoalDto) => void) | undefined;
}) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const role = me?.role ?? 'guest';
  const isManager = hasRoleAtLeast(role, 'manager');
  const isAdmin = hasRoleAtLeast(role, 'admin');
  const [form, setForm] = useState<Form>(() => initialForm(goal, me?.id ?? ''));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  const goalPeriod = goal?.period ?? period;
  const anchor = goal?.startDate ?? date;
  const parentPeriod = PARENT_PERIOD[goalPeriod];

  const parents = useQuery({
    queryKey: gk.parents(parentPeriod ?? goalPeriod, anchor ?? 'current'),
    queryFn: () => goalsApi.list({ period: parentPeriod!, date: anchor, owner: 'team' }),
    enabled: !!parentPeriod,
    staleTime: 30_000,
  });
  const parentOptions = (parents.data?.items ?? []).filter((p) => !isClosed(p) && p.id !== goal?.id);

  const projects = useActiveProjects();
  const leadProjects = (projects.data?.items ?? []).filter((p) => isAdmin || p.myRole === 'lead');

  const needsOwner = form.scope !== 'personal';
  const users = useQuery({
    queryKey: ['users', 'goal-owner-picker'],
    queryFn: () => usersApi.list({ limit: 100 }),
    enabled: needsOwner,
    staleTime: 60_000,
  });
  const owners = (users.data?.items ?? []).filter((u) => u.status === 'active' && (form.scope === 'personal' || u.role !== 'guest'));

  const onError = (err: unknown) => {
    const fe = serverFieldErrors(err);
    if (Object.keys(fe).length) setErrors(fe);
    else if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('Someone else just changed this goal. Reopen it to see the latest version.');
      refreshGoals(qc);
      onClose();
    } else setFormError(errorMessage(err));
  };

  const keyResultsBody = () =>
    form.keyResults.map((kr) => ({ ...(kr.id ? { id: kr.id } : {}), title: kr.title, target: num(kr.target), current: kr.current, unit: kr.unit }));

  const create = useMutation({
    mutationFn: goalsApi.create,
    onSuccess: (g) => {
      refreshGoals(qc);
      toast('Goal created');
      onCreated?.(g);
      onClose();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, input, version }: { id: string; input: UpdateGoalInput; version: number }) => goalsApi.update(id, input, version),
    onSuccess: (g) => {
      syncGoal(qc, g);
      // The parent's children list changes when the parent link does.
      void qc.invalidateQueries({ queryKey: gk.details });
      toast('Goal saved');
      onClose();
    },
    onError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const measureFields = {
      measure: form.measure,
      unit: form.measure === 'number' ? form.unit : '',
      ...(form.measure === 'number' ? { target: num(form.target) } : {}),
    };

    if (!goal) {
      const body = {
        title: form.title,
        description: form.description,
        scope: form.scope,
        projectId: form.scope === 'project' ? form.projectId || null : null,
        ...(needsOwner && form.ownerId ? { ownerId: form.ownerId } : {}),
        period,
        ...(date ? { date } : {}),
        ...measureFields,
        keyResults: keyResultsBody(),
        parentGoalId: form.parentGoalId || null,
      };
      const r = validate(createGoalSchema, body);
      if ('errors' in r) return setErrors(r.errors);
      setErrors({});
      create.mutate(r.data);
      return;
    }

    const body: UpdateGoalInput = {
      title: form.title,
      description: form.description,
      ...(needsOwner && form.ownerId && form.ownerId !== goal.owner?.id ? { ownerId: form.ownerId } : {}),
      ...measureFields,
      keyResults: keyResultsBody(),
      parentGoalId: form.parentGoalId || null,
    };
    const r = validate(updateGoalSchema, body);
    if ('errors' in r) return setErrors(r.errors);
    setErrors({});
    update.mutate({ id: goal.id, input: r.data, version: goal.version });
  };

  const setKr = (i: number, p: Partial<KrDraft>) => patch({ keyResults: form.keyResults.map((kr, j) => (j === i ? { ...kr, ...p } : kr)) });
  const hasKrs = form.keyResults.length > 0;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {formError && <ErrorNote>{formError}</ErrorNote>}

      <Field label="Title" error={errors.title}>
        {(id) => <Input id={id} value={form.title} maxLength={200} autoFocus onChange={(e) => patch({ title: e.target.value })} placeholder="Ship the onboarding flow" />}
      </Field>

      <Field label="Description" error={errors.description}>
        {(id) => <Textarea id={id} value={form.description} maxLength={5000} rows={2} onChange={(e) => patch({ description: e.target.value })} />}
      </Field>

      {!goal && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Scope" error={errors.scope}>
            {(id) => (
              <Select id={id} value={form.scope} onChange={(e) => patch({ scope: e.target.value as GoalScope, projectId: '' })}>
                <option value="personal">Personal</option>
                {isManager && <option value="team">Team</option>}
                {leadProjects.length > 0 && <option value="project">Project</option>}
              </Select>
            )}
          </Field>
          {form.scope === 'project' && (
            <Field label="Project" error={errors.projectId}>
              {(id) => (
                <Select id={id} value={form.projectId} onChange={(e) => patch({ projectId: e.target.value })}>
                  <option value="">Choose a project</option>
                  {leadProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      )}

      {needsOwner && (
        <Field label="Owner" error={errors.ownerId} hint="Who is accountable for this goal">
          {(id) => (
            <Select id={id} value={form.ownerId} onChange={(e) => patch({ ownerId: e.target.value })} disabled={users.isPending}>
              {!owners.some((u) => u.id === form.ownerId) && form.ownerId && <option value={form.ownerId}>{goal?.owner?.name ?? me?.name ?? 'Me'}</option>}
              {owners.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.id === me?.id ? ' (me)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_7rem_6rem]">
        <Field label="Measure" error={errors.measure} hint={hasKrs ? 'Key results decide progress.' : form.measure === 'tasks' ? 'Link tasks after creating.' : undefined}>
          {(id) => (
            <Select id={id} value={form.measure} onChange={(e) => patch({ measure: e.target.value as GoalMeasure })}>
              {GOAL_MEASURES.map((m) => (
                <option key={m} value={m}>
                  {MEASURE_LABEL[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {form.measure === 'number' && (
          <>
            <Field label="Target" error={errors.target}>
              {(id) => <Input id={id} type="number" min={0} step="any" inputMode="decimal" value={form.target} onChange={(e) => patch({ target: e.target.value })} />}
            </Field>
            <Field label="Unit" error={errors.unit}>
              {(id) => <Input id={id} value={form.unit} maxLength={20} placeholder="calls" onChange={(e) => patch({ unit: e.target.value })} />}
            </Field>
          </>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 flex w-full items-center text-xs font-medium text-muted">
          Key results <span className="ml-1 font-normal text-subtle">(optional)</span>
        </legend>
        {form.keyResults.map((kr, i) => (
          <div key={kr.id ?? `new-${i}`} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                className="h-8 flex-1"
                aria-label={`Key result ${i + 1} title`}
                placeholder="Key result"
                value={kr.title}
                maxLength={200}
                onChange={(e) => setKr(i, { title: e.target.value })}
              />
              <Input
                className="h-8 w-20"
                aria-label={`Key result ${i + 1} target`}
                placeholder="Target"
                type="number"
                min={0}
                step="any"
                value={kr.target}
                onChange={(e) => setKr(i, { target: e.target.value })}
              />
              <Input className="h-8 w-20" aria-label={`Key result ${i + 1} unit`} placeholder="Unit" value={kr.unit} maxLength={20} onChange={(e) => setKr(i, { unit: e.target.value })} />
              <button
                type="button"
                onClick={() => patch({ keyResults: form.keyResults.filter((_, j) => j !== i) })}
                className="rounded p-1 text-subtle hover:bg-hover hover:text-danger"
                aria-label={`Remove key result ${i + 1}`}
              >
                <X className="size-3.5" />
              </button>
            </div>
            {(errors[`keyResults.${i}.title`] ?? errors[`keyResults.${i}.target`] ?? errors[`keyResults.${i}.unit`] ?? errors[`keyResults.${i}.id`]) && (
              <p className="text-xs text-danger">
                {errors[`keyResults.${i}.title`] ?? errors[`keyResults.${i}.target`] ?? errors[`keyResults.${i}.unit`] ?? errors[`keyResults.${i}.id`]}
              </p>
            )}
          </div>
        ))}
        {errors.keyResults && <p className="text-xs text-danger">{errors.keyResults}</p>}
        {form.keyResults.length < MAX_KEY_RESULTS && (
          <Button type="button" size="sm" variant="ghost" onClick={() => patch({ keyResults: [...form.keyResults, { title: '', target: '', current: 0, unit: '' }] })}>
            <Plus className="size-3.5" />
            Add key result
          </Button>
        )}
      </fieldset>

      {parentPeriod && (
        <Field
          label={`Rolls up into (${PERIOD_LABEL[parentPeriod].toLowerCase()} goal)`}
          error={errors.parentGoalId}
          hint={parents.isSuccess && parentOptions.length === 0 ? `No open ${PERIOD_LABEL[parentPeriod].toLowerCase()} goals for that ${PERIOD_NOUN[parentPeriod]}.` : undefined}
        >
          {(id) => (
            <Select id={id} value={form.parentGoalId} onChange={(e) => patch({ parentGoalId: e.target.value })} disabled={parents.isPending}>
              <option value="">None</option>
              {form.parentGoalId && !parentOptions.some((p) => p.id === form.parentGoalId) && <option value={form.parentGoalId}>Current parent</option>}
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.owner && p.scope === 'personal' ? ` · ${p.owner.name}` : p.scope !== 'personal' ? ` · ${p.scope}` : ''}
                  {` (${goalPeriodShort(p)})`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending || update.isPending}>
          {goal ? 'Save' : 'Create goal'}
        </Button>
      </div>
    </form>
  );
}
