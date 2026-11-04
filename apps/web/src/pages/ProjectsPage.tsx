import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Users } from 'lucide-react';
import { createProjectSchema, hasRoleAtLeast, type ProjectStatus } from '@teamtrack/shared';
import { projectsApi } from '../api/endpoints';
import { useAuth } from '../stores/auth';
import { Button, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea, cx } from '../components/ui';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../lib/errors';

export const PROJECT_COLORS = ['#525252', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#0891b2', '#db2777'];

export function ProjectsPage() {
  const role = useAuth((s) => s.user?.role ?? 'guest');
  const [status, setStatus] = useState<ProjectStatus>('active');
  const [creating, setCreating] = useState(false);

  const q = useInfiniteQuery({
    // Its own key: other pages cache the plain first page under ['projects', 'active'], and an infinite
    // query stores { pages }, so sharing the key would hand them the wrong shape.
    queryKey: ['projects', status, 'pages'],
    queryFn: ({ pageParam }) => projectsApi.list({ status, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const projects = q.data?.pages.flatMap((p) => p.items) ?? [];
  const canCreate = hasRoleAtLeast(role, 'manager');

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New project
            </Button>
          )
        }
      />
      <Tabs value={status} onChange={setStatus} tabs={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }]} />

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote>{errorMessage(q.error)}</ErrorNote>
      ) : projects.length === 0 ? (
        <EmptyState
          title={status === 'active' ? 'No projects yet' : 'No archived projects'}
          {...(status === 'active' && canCreate
            ? { description: 'Projects group your tasks, tickets and boards.', action: <Button onClick={() => setCreating(true)}>Create a project</Button> }
            : {})}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="flex items-center gap-4 px-4 py-3.5 hover:bg-hover">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    <span className="font-mono text-xs text-subtle">{p.key}</span>
                    {p.visibility === 'private' && <Lock className="size-3 text-subtle" />}
                  </div>
                  {p.description && <p className="mt-0.5 truncate text-xs text-muted">{p.description}</p>}
                </div>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Users className="size-3.5" /> {p.memberCount}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}

      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function suggestKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4);
  return /^[A-Z]/.test(key) ? key.slice(0, 10) : '';
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const empty = { name: '', key: '', description: '', visibility: 'workspace', color: PROJECT_COLORS[1]! };
  const [form, setForm] = useState(empty);
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const create = useMutation({
    mutationFn: projectsApi.create,
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      close();
      navigate(`/projects/${p.id}`);
    },
    onError: (err) => setErrors({ ...serverFieldErrors(err), _form: errorMessage(err) }),
  });

  const close = () => {
    setForm(empty);
    setKeyTouched(false);
    setErrors({});
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(createProjectSchema, form);
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    create.mutate(v.data);
  };

  return (
    <Dialog open={open} onClose={close} title="New project">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {errors._form && <ErrorNote>{errors._form}</ErrorNote>}
        <Field label="Name" error={errors.name}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value, ...(keyTouched ? {} : { key: suggestKey(e.target.value) }) })}
            />
          )}
        </Field>
        <Field label="Key" error={errors.key} hint="Prefix for task IDs, e.g. WEB-42. Can't be changed later.">
          {(id) => (
            <Input
              id={id}
              value={form.key}
              maxLength={10}
              className="uppercase"
              onChange={(e) => {
                setKeyTouched(true);
                setForm({ ...form, key: e.target.value.toUpperCase() });
              }}
            />
          )}
        </Field>
        <Field label="Description" error={errors.description}>
          {(id) => <Textarea id={id} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
        </Field>
        <Field label="Visibility">
          {(id) => (
            <Select id={id} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              <option value="workspace">Everyone in the workspace</option>
              <option value="private">Only project members</option>
            </Select>
          )}
        </Field>
        <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted">Color</p>
      <div className="flex gap-2">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={value === c}
            onClick={() => onChange(c)}
            className={cx('size-6 rounded-full ring-offset-2 ring-offset-bg', value === c && 'ring-2 ring-fg')}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}
