import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updateMeSchema, type NotificationPrefsDto } from '@teamtrack/shared';
import { authApi, usersApi } from '../api/endpoints';
import { endSession } from '../api/client';
import { useAuth } from '../stores/auth';
import { toast, toastError } from '../stores/toast';
import { Button, Field, Input, PageHeader, Spinner } from '../components/ui';
import { qk } from '../lib/tasks';
import { errorMessage, problemOf, validate, type FieldErrors } from '../lib/errors';

export function SettingsPage() {
  const user = useAuth((s) => s.user);
  const workspace = useAuth((s) => s.workspace);
  const setUser = useAuth((s) => s.setUser);
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (n: string) => usersApi.updateMe(n, user!.version),
    onSuccess: (u) => {
      setUser(u);
      toast('Profile updated');
    },
    onError: (err) =>
      toastError(problemOf(err)?.code === 'STALE_VERSION' ? 'Your profile changed elsewhere. Refresh and try again.' : errorMessage(err)),
  });
  const signOutAll = useMutation({
    mutationFn: authApi.logoutAll,
    onSettled: () => {
      endSession();
      navigate('/login');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(updateMeSchema, { name });
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    save.mutate(v.data.name);
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-lg space-y-10">
        <section>
          <h2 className="mb-4 text-sm font-medium">Profile</h2>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Name" error={errors.name}>
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Email">{(id) => <Input id={id} value={user?.email ?? ''} disabled />}</Field>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={name.trim() === user?.name}>
              Save
            </Button>
          </form>
        </section>

        <EmailPreferences />

        <section className="border-t border-border pt-8">
          <h2 className="mb-1 text-sm font-medium">Workspace</h2>
          <p className="text-sm text-muted">
            {workspace?.name} · <span className="font-mono text-xs">{workspace?.slug}</span> · {workspace?.timezone}
          </p>
        </section>

        <section className="border-t border-border pt-8">
          <h2 className="mb-1 text-sm font-medium">Sessions</h2>
          <p className="mb-3 text-sm text-muted">Sign out of TeamTrack on every device, including this one</p>
          <Button loading={signOutAll.isPending} onClick={() => signOutAll.mutate()}>
            Sign out everywhere
          </Button>
        </section>
      </div>
    </>
  );
}

type EmailPref = keyof NotificationPrefsDto['email'];

const EMAIL_PREFS: { key: EmailPref; label: string; hint: string }[] = [
  { key: 'assigned', label: 'Assigned to me', hint: 'Someone gives you a task' },
  { key: 'testing', label: 'Testing', hint: 'You are asked to test something, or your work passes or fails testing' },
  { key: 'dueSoon', label: 'Due dates', hint: 'Your task is due today or tomorrow, or is overdue' },
  { key: 'mentioned', label: 'Comments and mentions', hint: 'Someone @mentions you, or comments on something you are part of' },
];

/** Each toggle saves on its own; the bell always shows everything regardless. */
function EmailPreferences() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: qk.preferences, queryFn: usersApi.preferences });
  const save = useMutation({
    mutationFn: (change: Partial<Record<EmailPref, boolean>>) => usersApi.updatePreferences({ email: change }),
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: qk.preferences });
      const before = qc.getQueryData<NotificationPrefsDto>(qk.preferences);
      if (before) qc.setQueryData<NotificationPrefsDto>(qk.preferences, { email: { ...before.email, ...change } });
      return { before };
    },
    onError: (err, _change, c) => {
      if (c?.before) qc.setQueryData(qk.preferences, c.before);
      toastError(errorMessage(err));
    },
    onSuccess: (p) => qc.setQueryData(qk.preferences, p),
  });

  return (
    <section className="border-t border-border pt-8">
      <h2 className="mb-1 text-sm font-medium">Email notifications</h2>
      <p className="mb-4 text-sm text-muted">Choose what we email you about. Everything still shows up under the bell.</p>
      {prefs.isPending ? (
        <Spinner />
      ) : prefs.isError ? (
        <p className="text-sm text-muted">{errorMessage(prefs.error)}</p>
      ) : (
        <div className="space-y-3">
          {EMAIL_PREFS.map((p) => (
            <label key={p.key} className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-fg)]"
                checked={prefs.data.email[p.key]}
                onChange={(e) => save.mutate({ [p.key]: e.target.checked })}
              />
              <span>
                <span className="block text-sm">{p.label}</span>
                <span className="block text-xs text-muted">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
