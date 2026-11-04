import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { assignableRoles, createInviteSchema, hasRoleAtLeast, outranks, type Role, type UserDto } from '@teamtrack/shared';
import { invitesApi, usersApi } from '../api/endpoints';
import { useAuth } from '../stores/auth';
import { toast, toastError } from '../stores/toast';
import { Avatar, Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Select, Spinner } from '../components/ui';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../lib/errors';

export function TeamPage() {
  const me = useAuth((s) => s.user);
  const myRole: Role = me?.role ?? 'guest';
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState(false);

  const users = useQuery({
    queryKey: ['users', search],
    queryFn: () => usersApi.list({ limit: 100, ...(search ? { q: search } : {}) }),
    placeholderData: (prev) => prev,
  });
  const canInvite = hasRoleAtLeast(myRole, 'manager');
  const invites = useQuery({ queryKey: ['invites'], queryFn: invitesApi.list, enabled: canInvite });

  const onError = (err: unknown) => toastError(errorMessage(err));
  const refreshUsers = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const setRole = useMutation({ mutationFn: (v: { id: string; role: Role }) => usersApi.setRole(v.id, v.role), onSuccess: refreshUsers, onError });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'suspended' }) => usersApi.setStatus(v.id, v.status),
    onSuccess: (u) => {
      refreshUsers();
      toast(u.status === 'suspended' ? `${u.name} suspended` : `${u.name} reactivated`);
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: invitesApi.revoke,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites'] }),
    onError,
  });

  const canManage = (u: UserDto) => u.id !== me?.id && u.role !== 'owner' && hasRoleAtLeast(myRole, 'admin') && outranks(myRole, u.role);

  return (
    <>
      <PageHeader
        title="Team"
        description="Everyone in your workspace"
        actions={
          canInvite && (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus className="size-4" /> Invite
            </Button>
          )
        }
      />

      <Input aria-label="Search people" placeholder="Search by name or email" className="mb-4 max-w-xs" value={search} onChange={(e) => setSearch(e.target.value)} />

      {users.isPending ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {users.data?.items.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar name={u.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {u.name} {u.id === me?.id && <span className="text-subtle">(you)</span>}
                </p>
                <p className="truncate text-xs text-muted">{u.email}</p>
              </div>
              {u.status === 'suspended' && <Badge className="text-danger">Suspended</Badge>}
              {canManage(u) ? (
                <>
                  <Select
                    aria-label={`Role for ${u.name}`}
                    className="h-8 w-28 text-xs capitalize"
                    value={u.role}
                    onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value as Role })}
                  >
                    {[...new Set([u.role, ...assignableRoles(myRole)])].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: u.id, status: u.status === 'suspended' ? 'active' : 'suspended' })}>
                    {u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                  </Button>
                </>
              ) : (
                <Badge className="capitalize">{u.role}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {canInvite && !!invites.data?.length && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-medium">Pending invites</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{i.email}</p>
                  <p className="text-xs text-muted">Expires {new Date(i.expiresAt).toLocaleDateString()}</p>
                </div>
                <Badge className="capitalize">{i.role}</Badge>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <InviteDialog open={inviting} onClose={() => setInviting(false)} roles={assignableRoles(myRole)} />
    </>
  );
}

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', role: roles.includes('member') ? 'member' : (roles[0] ?? 'member') });
  const [errors, setErrors] = useState<FieldErrors>({});

  const close = () => {
    setForm({ email: '', role: 'member' });
    setErrors({});
    onClose();
  };
  const invite = useMutation({
    mutationFn: invitesApi.create,
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: ['invites'] });
      toast(`Invite sent to ${i.email}`);
      close();
    },
    onError: (err) => setErrors({ ...serverFieldErrors(err), _form: errorMessage(err) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(createInviteSchema, form);
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    invite.mutate(v.data);
  };

  return (
    <Dialog open={open} onClose={close} title="Invite to workspace">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {errors._form && <ErrorNote>{errors._form}</ErrorNote>}
        <Field label="Email" error={errors.email}>
          {(id) => <Input id={id} type="email" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
        </Field>
        <Field label="Role" error={errors.role}>
          {(id) => (
            <Select id={id} className="capitalize" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <p className="text-xs text-muted">They'll get an email with a link to join. The link expires in 7 days.</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={invite.isPending}>
            Send invite
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
