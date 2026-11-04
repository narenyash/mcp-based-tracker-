import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { LifeBuoy, PenTool, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasRoleAtLeast, updateProjectSchema, type ProjectDto, type ProjectRole } from '@teamtrack/shared';
import { labelsApi, projectsApi, usersApi } from '../api/endpoints';
import { useAuth } from '../stores/auth';
import { toast, toastError } from '../stores/toast';
import { Avatar, Badge, Button, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea } from '../components/ui';
import { errorMessage, problemOf, validate, type FieldErrors } from '../lib/errors';
import { ColorPicker, PROJECT_COLORS } from './ProjectsPage';
import { Board } from '../components/task/Board';
import { TaskList } from '../components/task/TaskList';
import { TaskDrawer } from '../components/task/TaskDrawer';
import { qk, useLabels } from '../lib/tasks';
import { useProjectRoom } from '../lib/realtime';

type Tab = 'board' | 'list' | 'members' | 'settings';
const TABS: Tab[] = ['board', 'list', 'members', 'settings'];

/** Header shortcuts styled as secondary buttons (they navigate, so they stay links). */
const headerLink =
  'inline-flex h-9 items-center gap-2 rounded-md border border-border bg-bg px-3.5 text-sm font-medium transition-colors hover:bg-hover';

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const role = useAuth((s) => s.user?.role ?? 'guest');
  // View and open task live in the URL, so links to a task (e.g. from emails) open it directly.
  const [params, setParams] = useSearchParams();
  const view = params.get('view');
  const tab: Tab = TABS.includes(view as Tab) ? (view as Tab) : 'board';
  const openTaskId = params.get('task');
  const setTab = (t: Tab) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'board') next.delete('view');
      else next.set('view', t);
      return next;
    });
  const openTask = (taskId: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (taskId) next.set('task', taskId);
      else next.delete('task');
      return next;
    });
  const project = useQuery({ queryKey: ['project', id], queryFn: () => projectsApi.get(id) });
  useProjectRoom(id);

  if (project.isPending) return <Spinner />;
  if (project.isError) {
    return problemOf(project.error)?.status === 404 ? (
      <EmptyState title="Project not found" description="It may have been deleted, or you don't have access" />
    ) : (
      <ErrorNote>{errorMessage(project.error)}</ErrorNote>
    );
  }

  const p = project.data;
  const canManage = hasRoleAtLeast(role, 'admin') || p.myRole === 'lead';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-full" style={{ background: p.color }} />
            {p.name}
            <span className="font-mono text-sm font-normal text-subtle">{p.key}</span>
            {p.status === 'archived' && <Badge>Archived</Badge>}
          </span>
        }
        description={p.description || undefined}
        actions={
          <>
            <Link to={`/tickets?project=${p.id}&view=board`} className={headerLink}>
              <LifeBuoy className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
              Tickets
            </Link>
            <Link to={`/boards?project=${p.id}`} className={headerLink}>
              <PenTool className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
              Whiteboards
            </Link>
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'board', label: 'Board' },
          { value: 'list', label: 'List' },
          { value: 'members', label: `Members · ${p.memberCount}` },
          ...(canManage ? [{ value: 'settings' as const, label: 'Settings' }] : []),
        ]}
      />
      {tab === 'board' && <Board project={p} onOpen={openTask} />}
      {tab === 'list' && <TaskList project={p} onOpen={openTask} />}
      {tab === 'members' && <Members project={p} canManage={canManage} />}
      {tab === 'settings' && canManage && <ProjectSettings project={p} canDelete={hasRoleAtLeast(role, 'admin')} />}
      {openTaskId && <TaskDrawer project={p} taskId={openTaskId} onClose={() => openTask(null)} onOpen={openTask} />}
    </>
  );
}

const PROJECT_ROLES: ProjectRole[] = ['lead', 'member', 'viewer'];

function Members({ project, canManage }: { project: ProjectDto; canManage: boolean }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const members = useQuery({ queryKey: ['project', project.id, 'members'], queryFn: () => projectsApi.members(project.id) });
  const users = useQuery({ queryKey: ['users', ''], queryFn: () => usersApi.list({ limit: 100 }), enabled: canManage });
  const [adding, setAdding] = useState({ userId: '', role: 'member' as ProjectRole });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['project', project.id] });
  };
  const onError = (err: unknown) => toastError(errorMessage(err));

  const add = useMutation({
    mutationFn: () => projectsApi.addMember(project.id, adding.userId, adding.role),
    onSuccess: () => {
      setAdding({ userId: '', role: 'member' });
      refresh();
    },
    onError,
  });
  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: ProjectRole }) => projectsApi.setMemberRole(project.id, v.userId, v.role),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => projectsApi.removeMember(project.id, userId),
    onSuccess: refresh,
    onError,
  });

  if (members.isPending) return <Spinner />;
  const memberIds = new Set(members.data?.map((m) => m.userId));
  const candidates = (users.data?.items ?? []).filter((u) => u.status === 'active' && !memberIds.has(u.id));

  return (
    <div className="space-y-6">
      {canManage && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.userId) add.mutate();
          }}
        >
          <Select aria-label="Person" className="min-w-48 flex-1" value={adding.userId} onChange={(e) => setAdding({ ...adding, userId: e.target.value })}>
            <option value="">Add a person…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} · {u.email}
              </option>
            ))}
          </Select>
          <Select aria-label="Role" className="w-32" value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value as ProjectRole })}>
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r} className="capitalize">
                {r}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={!adding.userId} loading={add.isPending}>
            Add
          </Button>
        </form>
      )}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {members.data?.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={m.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {m.name} {m.userId === me?.id && <span className="text-subtle">(you)</span>}
              </p>
              <p className="truncate text-xs text-muted">{m.email}</p>
            </div>
            {canManage ? (
              <Select
                aria-label={`Role for ${m.name}`}
                className="h-8 w-28 text-xs"
                value={m.role}
                onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as ProjectRole })}
              >
                {PROJECT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            ) : (
              <Badge className="capitalize">{m.role}</Badge>
            )}
            {(canManage || m.userId === me?.id) && (
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.userId)}>
                {m.userId === me?.id ? 'Leave' : 'Remove'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectSettings({ project, canDelete }: { project: ProjectDto; canDelete: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: project.name, description: project.description, visibility: project.visibility, color: project.color });
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    setForm({ name: project.name, description: project.description, visibility: project.visibility, color: project.color });
  }, [project]);

  const onSaved = (p: ProjectDto) => {
    qc.setQueryData(['project', p.id], p);
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const onError = (err: unknown) => {
    if (problemOf(err)?.code === 'STALE_VERSION') {
      toastError('Someone else changed this project. Reloaded the latest version.');
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
    } else toastError(errorMessage(err));
  };

  const save = useMutation({
    mutationFn: (input: Parameters<typeof projectsApi.update>[1]) => projectsApi.update(project.id, input, project.version),
    onSuccess: (p) => {
      onSaved(p);
      toast('Project saved');
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: () => projectsApi.update(project.id, { status: project.status === 'active' ? 'archived' : 'active' }, project.version),
    onSuccess: onSaved,
    onError,
  });
  const del = useMutation({
    mutationFn: () => projectsApi.remove(project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      toast('Project deleted');
      navigate('/projects');
    },
    onError,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(updateProjectSchema, form);
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    save.mutate(v.data);
  };

  return (
    <div className="max-w-lg space-y-10">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name" error={errors.name}>
          {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="Description" error={errors.description}>
          {(id) => <Textarea id={id} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
        </Field>
        <Field label="Visibility">
          {(id) => (
            <Select id={id} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as ProjectDto['visibility'] })}>
              <option value="workspace">Everyone in the workspace</option>
              <option value="private">Only project members</option>
            </Select>
          )}
        </Field>
        <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save changes
        </Button>
      </form>

      <LabelSettings projectId={project.id} />

      <div className="space-y-3 border-t border-border pt-8">
        <h3 className="text-sm font-medium">{project.status === 'active' ? 'Archive project' : 'Restore project'}</h3>
        <p className="text-sm text-muted">
          {project.status === 'active' ? 'Archived projects are read-only and hidden from the main list.' : 'Move this project back to the active list.'}
        </p>
        <Button loading={archive.isPending} onClick={() => archive.mutate()}>
          {project.status === 'active' ? 'Archive' : 'Restore'}
        </Button>
      </div>

      {canDelete && (
        <div className="space-y-3 border-t border-border pt-8">
          <h3 className="text-sm font-medium">Delete project</h3>
          <p className="text-sm text-muted">The project is hidden immediately and permanently purged after 30 days</p>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => window.confirm(`Delete ${project.name}? This can't be undone from the app.`) && del.mutate()}
          >
            Delete project
          </Button>
        </div>
      )}
    </div>
  );
}

function LabelSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const labels = useLabels(projectId);
  const [name, setName] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[0]!);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.labels(projectId) });
    void qc.invalidateQueries({ queryKey: qk.board(projectId) });
    void qc.invalidateQueries({ queryKey: qk.tasks });
  };
  const create = useMutation({
    mutationFn: () => labelsApi.create(projectId, { name: name.trim(), color }),
    onSuccess: () => {
      setName('');
      refresh();
    },
    onError: (err) => toastError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (labelId: string) => labelsApi.remove(projectId, labelId),
    onSuccess: refresh,
    onError: (err) => toastError(errorMessage(err)),
  });

  return (
    <div className="space-y-3 border-t border-border pt-8">
      <h3 className="text-sm font-medium">Labels</h3>
      <p className="text-sm text-muted">Tag tasks (Bug, Design, Backend…) and filter by them in the List view</p>
      {!!labels.data?.length && (
        <ul className="flex flex-wrap gap-2">
          {labels.data.map((l) => (
            <li key={l.id} className="flex items-center gap-1.5 rounded-md border border-border py-1 pr-1 pl-2.5 text-xs">
              <span className="size-2 rounded-full" style={{ background: l.color }} />
              {l.name}
              <button
                onClick={() => window.confirm(`Delete the "${l.name}" label? It will be removed from every task.`) && remove.mutate(l.id)}
                className="rounded p-0.5 text-subtle hover:bg-hover hover:text-danger"
                aria-label={`Delete label ${l.name}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Input aria-label="Label name" placeholder="New label" className="w-48" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-1" role="radiogroup" aria-label="Label color">
          {PROJECT_COLORS.slice(0, 8).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={`size-5 rounded-full ${color === c ? 'ring-2 ring-fg ring-offset-2 ring-offset-bg' : ''}`}
              style={{ background: c }}
            />
          ))}
        </div>
        <Button type="submit" disabled={!name.trim()} loading={create.isPending}>
          Add label
        </Button>
      </form>
    </div>
  );
}
