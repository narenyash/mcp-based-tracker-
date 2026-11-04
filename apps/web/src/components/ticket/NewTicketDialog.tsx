import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTicketSchema, TICKET_SEVERITIES, TICKET_TYPES, type ProjectDto, type TicketDto, type TicketSeverity, type TicketType } from '@teamtrack/shared';
import { ticketsApi } from '../../api/tickets';
import { toastError } from '../../stores/toast';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../../lib/errors';
import { refreshTickets, SEVERITY_LABEL, TYPE_LABEL } from '../../lib/tickets';
import { Button, Dialog, Field, Input, Select, Textarea } from '../ui';

/** Report a bug, issue or request. Opens the new ticket on success. */
export function NewTicketDialog({
  projects,
  defaultProjectId,
  onClose,
  onCreated,
}: {
  projects: ProjectDto[];
  defaultProjectId: string | null;
  onClose: () => void;
  onCreated: (t: TicketDto) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    projectId: defaultProjectId ?? projects[0]?.id ?? '',
    title: '',
    type: 'bug' as TicketType,
    severity: 'medium' as TicketSeverity,
    description: '',
    stepsToReproduce: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: ({ projectId, ...input }: typeof form) => ticketsApi.create(projectId, input),
    onSuccess: (t) => {
      refreshTickets(qc, t.projectId);
      onCreated(t);
    },
    onError: (err) => {
      const fields = serverFieldErrors(err);
      if (Object.keys(fields).length) setErrors(fields);
      else toastError(errorMessage(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { projectId, ...input } = form;
    const v = validate(createTicketSchema, input);
    const next: FieldErrors = 'errors' in v ? v.errors : {};
    if (!projectId) next.projectId = 'Choose a project';
    setErrors(next);
    if (Object.keys(next).length === 0) create.mutate(form);
  };

  return (
    <Dialog open onClose={onClose} title="New ticket">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Title" error={errors.title}>
          {(id) => <Input id={id} autoFocus maxLength={200} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Short summary of the problem" />}
        </Field>
        <Field label="Project" error={errors.projectId}>
          {(id) => (
            <Select id={id} value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
              {!form.projectId && <option value="">Choose a project…</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            {(id) => (
              <Select id={id} value={form.type} onChange={(e) => set('type', e.target.value as TicketType)}>
                {TICKET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Severity">
            {(id) => (
              <Select id={id} value={form.severity} onChange={(e) => set('severity', e.target.value as TicketSeverity)}>
                {[...TICKET_SEVERITIES].reverse().map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description" error={errors.description}>
          {(id) => <Textarea id={id} rows={3} maxLength={20_000} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <Field label="Steps to reproduce" error={errors.stepsToReproduce} hint="Optional">
          {(id) => <Textarea id={id} rows={3} maxLength={5000} value={form.stepsToReproduce} onChange={(e) => set('stepsToReproduce', e.target.value)} placeholder={'1. Go to…\n2. Click…'} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create ticket
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
