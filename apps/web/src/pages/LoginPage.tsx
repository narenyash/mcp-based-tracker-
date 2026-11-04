import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { loginSchema } from '@teamtrack/shared';
import { authApi } from '../api/endpoints';
import { applySession } from '../api/client';
import { AuthCard } from '../components/guards';
import { Button, ErrorNote, Field, Input, Select } from '../components/ui';
import { errorMessage, problemOf, serverFieldErrors, validate, type FieldErrors } from '../lib/errors';

export function LoginPage() {
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [form, setForm] = useState({ email: '', password: '', workspace: '' });
  const [workspaces, setWorkspaces] = useState<{ slug: string; name: string }[] | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const v = validate(loginSchema, { ...form, workspace: form.workspace || undefined });
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    setBusy(true);
    try {
      applySession(await authApi.login(v.data));
      navigate(from, { replace: true });
    } catch (err) {
      const p = problemOf(err);
      if (p?.code === 'WORKSPACE_REQUIRED') {
        const list = (p.workspaces as { slug: string; name: string }[]) ?? [];
        setWorkspaces(list);
        setForm((f) => ({ ...f, workspace: list[0]?.slug ?? '' }));
      } else {
        setErrors(serverFieldErrors(err));
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Tasks, tickets and goals for your team">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {formError && <ErrorNote>{formError}</ErrorNote>}
        <Field label="Email" error={errors.email}>
          {(id) => (
            <Input id={id} type="email" autoComplete="email" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          )}
        </Field>
        <Field label="Password" error={errors.password}>
          {(id) => (
            <Input id={id} type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          )}
        </Field>
        {workspaces && (
          <Field label="Workspace" hint="This email belongs to more than one workspace">
            {(id) => (
              <Select id={id} value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })}>
                {workspaces.map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        New team?{' '}
        <Link to="/signup" className="text-fg underline underline-offset-4">
          Create a workspace
        </Link>
      </p>
    </AuthCard>
  );
}
