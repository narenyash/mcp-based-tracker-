import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Trash2, X } from 'lucide-react';
import {
  hasRoleAtLeast,
  TICKET_RESOLUTIONS,
  TICKET_SEVERITIES,
  TICKET_TYPES,
  type ProjectDto,
  type TicketBoardDto,
  type TicketDto,
  type TicketResolution,
  type TicketSeverity,
  type TicketType,
  type UpdateTicketInput,
} from '@teamtrack/shared';
import { tasksApi } from '../../api/endpoints';
import { ticketsApi } from '../../api/tickets';
import { useAuth } from '../../stores/auth';
import { toast, toastError } from '../../stores/toast';
import { errorMessage, problemOf } from '../../lib/errors';
import { useDebounced } from '../../lib/hooks';
import { useProjectRoom } from '../../lib/realtime';
import { qk, refreshProjectTasks, useAssignablePeople, useLabels } from '../../lib/tasks';
import { canEditProject, refreshTickets, RESOLUTION_LABEL, SEVERITY_LABEL, sortedTicketStatuses, syncTicket, tk, TYPE_LABEL, useProject } from '../../lib/tickets';
import { Avatar, Badge, Button, cx, ErrorNote, Input, Select, Sheet, Spinner } from '../ui';
import { StatusDot } from '../task/bits';
import { Attachments } from '../collab/Attachments';
import { CommentThread } from '../collab/CommentThread';
import { ActivityFeed } from '../collab/ActivityFeed';
import { InlineText, SeverityIcon, TypeIcon } from './bits';
import { useMoveTicket } from './useMoveTicket';

export function TicketDrawer({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const fromCache = () => {
    for (const [, board] of qc.getQueriesData<TicketBoardDto>({ queryKey: ['tickets', 'board'] })) {
      const hit = board?.tickets.find((t) => t.id === ticketId);
      if (hit) return hit;
    }
    return undefined;
  };
  const ticket = useQuery({ queryKey: tk.ticket(ticketId), queryFn: () => ticketsApi.get(ticketId), placeholderData: fromCache });
  const project = useProject(ticket.data?.projectId ?? null);
  const error = ticket.error ?? project.error;

  return (
    <Sheet open onClose={onClose} label="Ticket details">
      {ticket.data && project.data ? (
        <TicketDetail key={ticket.data.id} project={project.data} ticket={ticket.data} onClose={onClose} />
      ) : (
        <div className="p-6">
          {error ? <ErrorNote>{problemOf(error)?.status === 404 ? 'This ticket was deleted or you no longer have access.' : errorMessage(error)}</ErrorNote> : <Spinner />}
        </div>
      )}
    </Sheet>
  );
}

function TicketDetail({ project, ticket: t, onClose }: { project: ProjectDto; ticket: TicketDto; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const role = me?.role ?? 'guest';
  const isAdmin = hasRoleAtLeast(role, 'admin');
  useProjectRoom(project.id);
  const { people } = useAssignablePeople(project.id);
  const members = people.filter((p) => p.isMember);
  const labels = useLabels(project.id);
  const { requestMove, dialog } = useMoveTicket(project);
  const statuses = sortedTicketStatuses(project);
  const status = statuses.find((s) => s.id === t.statusId);
  const canEdit = canEditProject(project, isAdmin);
  const canDelete = canEdit && (isAdmin || project.myRole === 'lead' || hasRoleAtLeast(role, 'manager') || t.reporter?.id === me?.id);

  const onError = (err: unknown) => {
    if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('Someone else just changed this ticket. Showing the latest version.');
      void qc.invalidateQueries({ queryKey: tk.ticket(t.id) });
    } else toastError(errorMessage(err));
  };
  const latestVersion = () => qc.getQueryData<TicketDto>(tk.ticket(t.id))?.version ?? t.version;

  const update = useMutation({
    mutationFn: (input: UpdateTicketInput) => ticketsApi.update(t.id, input, latestVersion()),
    onSuccess: (x) => syncTicket(qc, x),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => ticketsApi.remove(t.id),
    onSuccess: () => {
      refreshTickets(qc, project.id);
      qc.removeQueries({ queryKey: tk.ticket(t.id) });
      toast(`${t.key} deleted`);
      onClose();
    },
    onError,
  });
  const convert = useMutation({
    mutationFn: () => ticketsApi.convertToTask(t.id),
    onSuccess: ({ ticket, task }) => {
      syncTicket(qc, ticket);
      refreshProjectTasks(qc, project.id);
      toast(`Created ${task.key}`);
    },
    onError,
  });

  const save = (input: UpdateTicketInput) => update.mutate(input);
  const saveEnv = (key: keyof TicketDto['environment'], value: string) => save({ environment: { ...t.environment, [key]: value } });

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        <span className="job-tag">{t.key}</span>
        <Badge>{TYPE_LABEL[t.type]}</Badge>
        <span className="truncate text-xs text-subtle">{project.name}</span>
        <div className="ml-auto flex items-center gap-1">
          {canDelete && (
            <button
              onClick={() => window.confirm(`Delete ${t.key}?`) && remove.mutate()}
              className="rounded p-1.5 text-muted hover:bg-hover hover:text-danger"
              aria-label="Delete ticket"
              title="Delete ticket"
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
        <InlineText value={t.title} disabled={!canEdit} onSave={(title) => save({ title })} className="text-lg font-medium" ariaLabel="Title" required />

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
          <Prop label="Type">
            <div className="flex items-center gap-2">
              <TypeIcon type={t.type} />
              <Select aria-label="Type" className="h-8" disabled={!canEdit} value={t.type} onChange={(e) => save({ type: e.target.value as TicketType })}>
                {TICKET_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {TYPE_LABEL[x]}
                  </option>
                ))}
              </Select>
            </div>
          </Prop>
          <Prop label="Severity">
            <div className="flex items-center gap-2">
              <SeverityIcon severity={t.severity} />
              <Select aria-label="Severity" className="h-8" disabled={!canEdit} value={t.severity} onChange={(e) => save({ severity: e.target.value as TicketSeverity })}>
                {[...TICKET_SEVERITIES].reverse().map((x) => (
                  <option key={x} value={x}>
                    {SEVERITY_LABEL[x]}
                  </option>
                ))}
              </Select>
            </div>
          </Prop>
          <Prop label="Assignee">
            <div className="flex items-center gap-2">
              <Select aria-label="Assignee" className="h-8" disabled={!canEdit} value={t.assignee?.id ?? ''} onChange={(e) => save({ assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {/* Keep a current assignee who has since left the project visible. */}
                {t.assignee && !members.some((p) => p.userId === t.assignee?.id) && <option value={t.assignee.id}>{t.assignee.name}</option>}
                {members.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                    {p.userId === me?.id ? ' (me)' : ''}
                  </option>
                ))}
              </Select>
              {canEdit && t.assignee?.id !== me?.id && members.some((p) => p.userId === me?.id) && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => save({ assigneeId: me!.id })}>
                  Assign to me
                </Button>
              )}
            </div>
          </Prop>
          <Prop label="Reported by">
            <span className="flex items-center gap-2">
              {t.reporter ? <Avatar name={t.reporter.name} size={20} /> : null}
              <span>{t.reporter?.name ?? 'Unknown'}</span>
              <span className="text-xs text-subtle">{new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </span>
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

        {t.resolution && (
          <section className="space-y-2 rounded-lg border border-border p-3.5">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">Resolution</h3>
              <Select
                aria-label="Resolution"
                className="ml-auto h-8 w-44"
                disabled={!canEdit}
                value={t.resolution}
                onChange={(e) => save({ resolution: e.target.value as TicketResolution })}
              >
                {TICKET_RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {RESOLUTION_LABEL[r]}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-muted">
              {t.resolvedBy ? `Resolved by ${t.resolvedBy.name}` : 'Resolved'}
              {t.resolvedAt && ` on ${new Date(t.resolvedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
              {t.duplicateOf && ` · duplicate of ${t.duplicateOf.key}`}
              {t.reopenCount > 0 && ` · reopened ${t.reopenCount}×`}
            </p>
          </section>
        )}
        {!t.resolution && t.reopenCount > 0 && <p className="text-xs text-muted">Reopened {t.reopenCount}×</p>}

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">Description</h3>
          <InlineText value={t.description} disabled={!canEdit} onSave={(description) => save({ description })} multiline ariaLabel="Description" placeholder="What happened?" />
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">Environment</h3>
          <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-1 text-sm">
            {(['browser', 'os', 'version', 'url'] as const).map((key) => (
              <Prop key={key} label={{ browser: 'Browser', os: 'OS', version: 'App version', url: 'URL' }[key]}>
                <InlineText
                  value={t.environment[key]}
                  disabled={!canEdit}
                  onSave={(v) => saveEnv(key, v)}
                  ariaLabel={key}
                  maxLength={key === 'url' ? 2000 : 300}
                  placeholder={canEdit ? 'Add' : ''}
                  className="text-sm"
                />
              </Prop>
            ))}
          </dl>
        </section>

        {(
          [
            ['stepsToReproduce', 'Steps to reproduce', '1. Go to…\n2. Click…'],
            ['expected', 'Expected', 'What should happen'],
            ['actual', 'Actual', 'What happens instead'],
          ] as const
        ).map(([field, label, placeholder]) => (
          <section key={field}>
            <h3 className="mb-2 text-xs font-medium text-muted">{label}</h3>
            <InlineText value={t[field]} disabled={!canEdit} onSave={(v) => save({ [field]: v })} multiline maxLength={5000} ariaLabel={label} placeholder={placeholder} />
          </section>
        ))}

        <LinkedTasks project={project} ticket={t} canEdit={canEdit} onError={onError} />

        {canEdit && (
          <Button size="sm" onClick={() => convert.mutate()} loading={convert.isPending}>
            <ArrowRightLeft className="size-3.5" />
            Convert to task
          </Button>
        )}

        <Attachments entityType="ticket" entityId={t.id} canWrite={canEdit} />
        <CommentThread entityType="ticket" entityId={t.id} canWrite={canEdit} />
        <ActivityFeed entityType="ticket" entityId={t.id} canWrite={canEdit} />

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

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function LinkedTasks({ project, ticket: t, canEdit, onError }: { project: ProjectDto; ticket: TicketDto; canEdit: boolean; onError: (err: unknown) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const results = useQuery({
    queryKey: [...qk.tasks, 'link-search', project.id, q],
    queryFn: () => tasksApi.list({ projectId: project.id, q, limit: 8, state: 'all' }),
    enabled: canEdit && q.length > 0,
  });
  const link = useMutation({
    mutationFn: (taskId: string) => ticketsApi.linkTask(t.id, taskId),
    onSuccess: (x) => {
      setSearch('');
      syncTicket(qc, x);
    },
    onError,
  });
  const unlink = useMutation({ mutationFn: (taskId: string) => ticketsApi.unlinkTask(t.id, taskId), onSuccess: (x) => syncTicket(qc, x), onError });
  const linkedIds = new Set(t.linkedTasks.map((l) => l.id));
  const candidates = (results.data?.items ?? []).filter((x) => !linkedIds.has(x.id));
  const statusOf = (statusId: string) => project.workflow.taskStatuses.find((s) => s.id === statusId);

  if (!canEdit && t.linkedTasks.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
        Linked tasks
        {t.linkedTasks.length > 0 && <span className="text-subtle tabular-nums">{t.linkedTasks.length}</span>}
      </h3>
      {t.linkedTasks.length > 0 && (
        <ul className="mb-2 divide-y divide-border rounded-md border border-border">
          {t.linkedTasks.map((l) => {
            const s = statusOf(l.statusId);
            return (
              <li key={l.id} className="group flex items-center gap-2.5 px-3 py-2">
                {s && <StatusDot color={s.color} />}
                <Link to={`/projects/${l.projectId}?task=${l.id}`} className={cx('min-w-0 flex-1 truncate text-sm hover:underline', l.statusCategory === 'done' && 'text-muted line-through')}>
                  {l.title}
                </Link>
                <span className="job-tag">{l.key}</span>
                {canEdit && (
                  <button
                    onClick={() => unlink.mutate(l.id)}
                    className="rounded p-0.5 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                    aria-label={`Unlink ${l.key}`}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <div className="relative">
          <Input className="h-8" placeholder="Link a task: search title or key" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          {q && (
            <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-bg py-1 shadow-lg">
              {results.isPending ? (
                <li className="px-3 py-2">
                  <Spinner />
                </li>
              ) : candidates.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted">No matching tasks</li>
              ) : (
                candidates.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => link.mutate(c.id)} disabled={link.isPending} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-hover">
                      <span className="w-16 shrink-0"><span className="job-tag">{c.key}</span></span>
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
