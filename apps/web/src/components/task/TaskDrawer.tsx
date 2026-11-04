import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, FlaskConical, Plus, Trash2, X } from 'lucide-react';
import {
  hasRoleAtLeast,
  TASK_PRIORITIES,
  type BoardDto,
  type ProjectDto,
  type TaskDto,
  type TaskPriority,
  type UpdateTaskInput,
} from '@teamtrack/shared';
import { tasksApi } from '../../api/endpoints';
import { useAuth } from '../../stores/auth';
import { toast, toastError } from '../../stores/toast';
import { errorMessage, problemOf } from '../../lib/errors';
import { firstStatusOf, qk, refreshProjectTasks, sortedStatuses, syncTask, useAssignablePeople, useLabels } from '../../lib/tasks';
import { SlideToAdvance } from './SlideToAdvance';
import { Avatar, Badge, Button, cx, ErrorNote, Input, Select, Sheet, Spinner, Textarea } from '../ui';
import { PRIORITY_LABEL, PriorityIcon, StatusDot, TestingBadge } from './bits';
import { useMoveTask } from './useMoveTask';
import { Attachments } from '../collab/Attachments';
import { CommentThread } from '../collab/CommentThread';
import { ActivityFeed } from '../collab/ActivityFeed';

export function TaskDrawer({ project, taskId, onClose, onOpen }: { project: ProjectDto; taskId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const fromBoard = qc.getQueryData<BoardDto>(qk.board(project.id))?.tasks.find((t) => t.id === taskId);
  const task = useQuery({ queryKey: qk.task(taskId), queryFn: () => tasksApi.get(taskId), placeholderData: () => fromBoard });

  return (
    <Sheet open onClose={onClose} label="Task details">
      {task.data ? (
        <TaskDetail key={task.data.id} project={project} task={task.data} onClose={onClose} onOpen={onOpen} />
      ) : (
        <div className="p-6">
          {task.isError ? <ErrorNote>{problemOf(task.error)?.status === 404 ? 'This task was deleted or you no longer have access.' : errorMessage(task.error)}</ErrorNote> : <Spinner />}
        </div>
      )}
    </Sheet>
  );
}

function TaskDetail({ project, task: t, onClose, onOpen }: { project: ProjectDto; task: TaskDto; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const role = me?.role ?? 'guest';
  const { people } = useAssignablePeople(project.id);
  const labels = useLabels(project.id);
  const { requestMove, dialog, canManage } = useMoveTask(project);
  const statuses = sortedStatuses(project);
  const status = statuses.find((s) => s.id === t.statusId);
  const canEdit = project.status === 'active' && (canManage || project.myRole === 'member');
  const canDelete = canEdit && (canManage || hasRoleAtLeast(role, 'manager') || t.reporter?.id === me?.id);
  const testingStatus = firstStatusOf(project, 'testing');

  const onError = (err: unknown) => {
    if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('Someone else just changed this task. Showing the latest version.');
      void qc.invalidateQueries({ queryKey: qk.task(t.id) });
    } else toastError(errorMessage(err));
  };
  const latestVersion = () => qc.getQueryData<TaskDto>(qk.task(t.id))?.version ?? t.version;

  const update = useMutation({
    mutationFn: (input: UpdateTaskInput) => tasksApi.update(t.id, input, latestVersion()),
    onSuccess: (x) => syncTask(qc, x),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => tasksApi.remove(t.id),
    onSuccess: () => {
      refreshProjectTasks(qc, project.id);
      if (t.parentTaskId) void qc.invalidateQueries({ queryKey: qk.task(t.parentTaskId) });
      qc.removeQueries({ queryKey: qk.task(t.id) });
      toast(`${t.key} deleted`);
      if (t.parentTaskId) onOpen(t.parentTaskId);
      else onClose();
    },
    onError,
  });

  const save = (input: UpdateTaskInput) => update.mutate(input);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        {t.parentTaskId && (
          <button onClick={() => onOpen(t.parentTaskId!)} className="-ml-1.5 rounded p-1 text-muted hover:bg-hover" aria-label="Back to parent task">
            <ChevronLeft className="size-4" />
          </button>
        )}
        <span className="job-tag">{t.key}</span>
        {t.parentTaskId && <Badge>Subtask</Badge>}
        <div className="ml-auto flex items-center gap-1">
          {canDelete && (
            <button
              onClick={() => window.confirm(`Delete ${t.key}${t.counts.subtasks ? ` and its ${t.counts.subtasks} subtasks` : ''}?`) && remove.mutate()}
              className="rounded p-1.5 text-muted hover:bg-hover hover:text-danger"
              aria-label="Delete task"
              title="Delete task"
            >
              <Trash2 className="size-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded p-1.5 text-muted hover:bg-hover" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
        <InlineText
          value={t.title}
          disabled={!canEdit}
          onSave={(title) => save({ title })}
          className="text-lg font-medium"
          ariaLabel="Title"
          required
        />

        <NextStep project={project} task={t} canEdit={canEdit} canFinishTesting={t.tester?.id === me?.id || canManage} requestMove={requestMove} />

        <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-2.5 text-sm">
          <Prop label="Status">
            <Select
              aria-label="Status"
              className="h-8"
              disabled={!canEdit}
              value={t.statusId}
              onChange={(e) => {
                const next = statuses.find((s) => s.id === e.target.value);
                if (next) requestMove(t, next);
              }}
            >
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Prop>
          <Prop label="Created by">
            <span className="flex items-center gap-2">
              {t.reporter ? <Avatar name={t.reporter.name} size={20} /> : null}
              <span>{t.reporter?.name ?? 'Unknown'}</span>
              <span className="text-xs text-subtle">{new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </span>
          </Prop>
          <Prop label="Assignee">
            <div className="flex items-center gap-2">
              <Select aria-label="Assignee" className="h-8" disabled={!canEdit} value={t.assignee?.id ?? ''} onChange={(e) => save({ assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {people.map((p) => (
                  // The tester can't also be the assignee; show them, but explain why they can't be picked.
                  <option key={p.userId} value={p.userId} disabled={p.userId === t.tester?.id}>
                    {p.name}
                    {p.userId === me?.id ? ' (me)' : ''}
                    {p.userId === t.tester?.id ? ' (testing this task)' : p.isMember ? '' : ' (will join the project)'}
                  </option>
                ))}
              </Select>
              {canEdit && t.assignee?.id !== me?.id && t.tester?.id !== me?.id && people.some((p) => p.userId === me?.id) && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => save({ assigneeId: me!.id })}>
                  Assign to me
                </Button>
              )}
            </div>
          </Prop>
          <Prop label="Tester">
            <Select aria-label="Tester" className="h-8" disabled={!canEdit} value={t.tester?.id ?? ''} onChange={(e) => save({ testerId: e.target.value || null })}>
              {t.statusCategory !== 'testing' && <option value="">No tester</option>}
              {people.map((p) => (
                <option key={p.userId} value={p.userId} disabled={p.userId === t.assignee?.id}>
                  {p.name}
                  {p.userId === me?.id ? ' (me)' : ''}
                  {p.userId === t.assignee?.id ? ' (assigned, can\'t test own work)' : p.isMember ? '' : ' (will join the project)'}
                </option>
              ))}
            </Select>
          </Prop>
          <Prop label="Priority">
            <div className="flex items-center gap-2">
              <PriorityIcon priority={t.priority} />
              <Select aria-label="Priority" className="h-8" disabled={!canEdit} value={t.priority} onChange={(e) => save({ priority: e.target.value as TaskPriority })}>
                {[...TASK_PRIORITIES].reverse().map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          </Prop>
          <Prop label="Due date">
            <Input type="date" aria-label="Due date" className="h-8" disabled={!canEdit} value={t.dueDate ?? ''} onChange={(e) => save({ dueDate: e.target.value || null })} />
          </Prop>
          <Prop label="Labels">
            {labels.data?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {labels.data.map((l) => {
                  const on = t.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      disabled={!canEdit}
                      aria-pressed={on}
                      onClick={() => save({ labelIds: on ? t.labelIds.filter((x) => x !== l.id) : [...t.labelIds, l.id] })}
                      className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs', on ? 'border-fg' : 'border-border text-muted hover:text-fg')}
                    >
                      <span className="size-1.5 rounded-full" style={{ background: l.color }} />
                      {l.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-xs text-subtle">No labels yet. Leads can add them in project settings.</span>
            )}
          </Prop>
        </dl>

        <TestingPanel
          task={t}
          canFinish={t.tester?.id === me?.id || canManage}
          canSend={canEdit && !!testingStatus && (t.statusCategory === 'todo' || t.statusCategory === 'in_progress')}
          onSend={() => testingStatus && requestMove(t, testingStatus)}
          onPass={() => {
            const done = firstStatusOf(project, 'done');
            if (done) requestMove(t, done);
          }}
          onFail={() => {
            const back = firstStatusOf(project, 'in_progress') ?? firstStatusOf(project, 'todo');
            if (back) requestMove(t, back);
          }}
        />

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">Description</h3>
          <InlineText value={t.description} disabled={!canEdit} onSave={(description) => save({ description })} multiline ariaLabel="Description" placeholder="Add details, acceptance criteria, links…" />
        </section>

        {!t.parentTaskId && <Subtasks project={project} parent={t} canEdit={canEdit} onOpen={onOpen} requestMove={requestMove} />}
        <Checklist task={t} canEdit={canEdit} onError={onError} />

        <Attachments entityType="task" entityId={t.id} canWrite={canEdit} />
        <CommentThread entityType="task" entityId={t.id} canWrite={canEdit} />
        <ActivityFeed entityType="task" entityId={t.id} canWrite={canEdit} />

        <p className="border-t border-border pt-4 text-xs text-subtle">
          {status && (
            <span className="mr-3 inline-flex items-center gap-1.5">
              <StatusDot color={status.color} /> {status.name}
            </span>
          )}
          Updated {new Date(t.updatedAt).toLocaleString()}
        </p>
      </div>
      {dialog}
    </div>
  );
}

/** The slider that pushes the task one step along the workflow, with wording for the testing rules. */
function NextStep({
  project,
  task: t,
  canEdit,
  canFinishTesting,
  requestMove,
}: {
  project: ProjectDto;
  task: TaskDto;
  canEdit: boolean;
  canFinishTesting: boolean;
  requestMove: ReturnType<typeof useMoveTask>['requestMove'];
}) {
  const statuses = sortedStatuses(project);
  const index = statuses.findIndex((s) => s.id === t.statusId);
  if (!canEdit || index === -1) return null;

  if (t.statusCategory === 'testing') {
    const done = firstStatusOf(project, 'done');
    if (!done) return null;
    if (!canFinishTesting) {
      return (
        <p className="rounded-full border border-dashed border-border px-4 py-3 text-center text-sm text-muted">
          Waiting for {t.tester?.name ?? 'the tester'} to test this
        </p>
      );
    }
    return <SlideToAdvance key={t.statusId} label="Slide to pass testing" color={done.color} onComplete={() => requestMove(t, done)} />;
  }

  const next = statuses[index + 1];
  if (!next) {
    return (
      <p className="rounded-full border border-border bg-surface px-4 py-3 text-center text-sm text-muted">
        Done{t.completedAt ? ` · ${new Date(t.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
      </p>
    );
  }
  const label = next.category === 'testing' ? 'Slide to send to testing' : `Slide to move to ${next.name}`;
  return <SlideToAdvance key={t.statusId} label={label} color={next.color} onComplete={() => requestMove(t, next)} />;
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Text that saves on blur (or Enter for single-line). Keeps local edits until the server value changes. */
function InlineText({
  value,
  onSave,
  disabled,
  multiline,
  className,
  ariaLabel,
  placeholder,
  required,
}: {
  value: string;
  onSave: (v: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  className?: string;
  ariaLabel: string;
  placeholder?: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = multiline ? draft : draft.trim();
    if (next === value) return;
    if (required && !next) return setDraft(value);
    onSave(next);
  };
  const shared = {
    'aria-label': ariaLabel,
    value: draft,
    disabled,
    placeholder,
    onBlur: commit,
    className: cx('w-full rounded-md border border-transparent bg-transparent px-2 py-1 -mx-2 hover:border-border focus:border-fg focus:outline-none disabled:hover:border-transparent', className),
  };
  return multiline ? (
    <Textarea {...shared} rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))} maxLength={20_000} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...shared}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function TestingPanel({
  task: t,
  canFinish,
  canSend,
  onSend,
  onPass,
  onFail,
}: {
  task: TaskDto;
  canFinish: boolean;
  canSend: boolean;
  onSend: () => void;
  onPass: () => void;
  onFail: () => void;
}) {
  const testing = t.testing;
  if (!testing) {
    return canSend ? (
      <Button size="sm" onClick={onSend}>
        <FlaskConical className="size-3.5" />
        Send to testing
      </Button>
    ) : null;
  }
  const inTesting = t.statusCategory === 'testing';
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <section className="space-y-2.5 rounded-lg border border-border p-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Testing</h3>
        <span className="text-xs text-subtle">round {testing.round}</span>
        <span
          className={cx(
            'ml-auto text-xs font-medium',
            testing.result === 'pending' ? 'text-amber-600 dark:text-amber-400' : testing.result === 'passed' ? 'text-success' : 'text-danger',
          )}
        >
          {testing.result === 'pending' ? 'In progress' : testing.result === 'passed' ? 'Passed' : 'Failed'}
        </span>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {testing.sentBy?.name ?? 'Someone'} sent it to
        {t.tester ? (
          <span className="inline-flex items-center gap-1 text-fg">
            <Avatar name={t.tester.name} size={16} /> {t.tester.name}
          </span>
        ) : (
          'a tester'
        )}
        on {when(testing.sentAt)}
        {testing.resultAt && testing.resultBy && (
          <>
            · {testing.result === 'passed' ? 'passed' : 'failed'} by {testing.resultBy.name} on {when(testing.resultAt)}
          </>
        )}
      </p>
      {testing.note && <p className="rounded-md bg-surface px-3 py-2 text-sm whitespace-pre-wrap">{testing.note}</p>}
      {inTesting && canFinish && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="primary" onClick={onPass}>
            Pass
          </Button>
          <Button size="sm" variant="danger" onClick={onFail}>
            Fail
          </Button>
        </div>
      )}
      {!inTesting && canSend && (
        <Button size="sm" onClick={onSend}>
          <FlaskConical className="size-3.5" />
          Send to testing again
        </Button>
      )}
    </section>
  );
}

function Subtasks({
  project,
  parent,
  canEdit,
  onOpen,
  requestMove,
}: {
  project: ProjectDto;
  parent: TaskDto;
  canEdit: boolean;
  onOpen: (id: string) => void;
  requestMove: ReturnType<typeof useMoveTask>['requestMove'];
}) {
  const qc = useQueryClient();
  const subtasks = useQuery({ queryKey: [...qk.tasks, 'subtasks', parent.id], queryFn: () => tasksApi.list({ parentId: parent.id, limit: 100 }) });
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: (t: string) => tasksApi.create(project.id, { title: t, parentTaskId: parent.id }),
    onSuccess: () => {
      setTitle('');
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.task(parent.id) });
      void qc.invalidateQueries({ queryKey: qk.board(project.id) });
    },
    onError: (err) => toastError(errorMessage(err)),
  });
  const done = firstStatusOf(project, 'done');
  const todo = firstStatusOf(project, 'todo');
  const items = subtasks.data?.items ?? [];

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        Subtasks
        {parent.counts.subtasks > 0 && (
          <span className="text-subtle tabular-nums">
            {parent.counts.subtasksDone}/{parent.counts.subtasks}
          </span>
        )}
      </h3>
      {items.length > 0 && (
        <ul className="mb-2 divide-y divide-border rounded-md border border-border">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 px-3 py-2">
              <input
                type="checkbox"
                aria-label={`Mark ${s.key} ${s.statusCategory === 'done' ? 'not done' : 'done'}`}
                disabled={!canEdit}
                checked={s.statusCategory === 'done'}
                onChange={() => {
                  const target = s.statusCategory === 'done' ? todo : done;
                  if (target) requestMove(s, target);
                }}
                className="size-3.5 accent-current"
              />
              <button onClick={() => onOpen(s.id)} className={cx('min-w-0 flex-1 truncate text-left text-sm hover:underline', s.statusCategory === 'done' && 'text-muted line-through')}>
                {s.title}
              </button>
              {s.statusCategory === 'testing' && <TestingBadge task={s} />}
              {s.assignee && <Avatar name={s.assignee.name} size={18} />}
              <span className="job-tag">{s.key}</span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) add.mutate(title.trim());
          }}
        >
          <Input className="h-8" placeholder="Add a subtask" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          <Button size="sm" type="submit" loading={add.isPending} disabled={!title.trim()} aria-label="Add subtask">
            <Plus className="size-3.5" />
          </Button>
        </form>
      )}
    </section>
  );
}

function Checklist({ task: t, canEdit, onError }: { task: TaskDto; canEdit: boolean; onError: (err: unknown) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const onSuccess = (x: TaskDto) => syncTask(qc, x);
  const add = useMutation({
    mutationFn: (v: string) => tasksApi.addChecklistItem(t.id, v),
    onSuccess: (x) => {
      setText('');
      onSuccess(x);
    },
    onError,
  });
  const toggle = useMutation({ mutationFn: (v: { id: string; done: boolean }) => tasksApi.updateChecklistItem(t.id, v.id, { done: v.done }), onSuccess, onError });
  const remove = useMutation({ mutationFn: (id: string) => tasksApi.removeChecklistItem(t.id, id), onSuccess, onError });
  const { checklist, checklistDone } = t.counts;
  const pct = checklist ? Math.round((checklistDone / checklist) * 100) : 0;

  if (!canEdit && checklist === 0) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        Checklist
        {checklist > 0 && <span className="text-subtle tabular-nums">{pct}%</span>}
      </h3>
      {checklist > 0 && (
        <>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-success transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <ul className="mb-2 space-y-0.5">
            {t.checklist.map((item) => (
              <li key={item.id} className="group flex items-center gap-2.5 rounded px-1 py-1 hover:bg-hover">
                <input
                  type="checkbox"
                  aria-label={item.text}
                  disabled={!canEdit}
                  checked={item.done}
                  onChange={() => toggle.mutate({ id: item.id, done: !item.done })}
                  className="size-3.5 accent-current"
                />
                <span className={cx('flex-1 text-sm', item.done && 'text-muted line-through')}>{item.text}</span>
                {canEdit && (
                  <button
                    onClick={() => remove.mutate(item.id)}
                    className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                    aria-label={`Remove ${item.text}`}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate(text.trim());
          }}
        >
          <Input className="h-8" placeholder="Add an item" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" type="submit" loading={add.isPending} disabled={!text.trim()} aria-label="Add checklist item">
            <Plus className="size-3.5" />
          </Button>
        </form>
      )}
    </section>
  );
}
