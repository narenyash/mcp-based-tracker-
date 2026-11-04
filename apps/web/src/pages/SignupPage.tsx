import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { signupSchema } from '@teamtrack/shared';
import { authApi } from '../api/endpoints';
import { applySession } from '../api/client';
import { AuthCard } from '../components/guards';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../lib/errors';

export function SignupPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ workspaceName: '', name: '', email: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const v = validate(signupSchema, form);
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    setBusy(true);
    try {
      applySession(await authApi.signup(v.data));
      navigate('/', { replace: true });
    } catch (err) {
      setErrors(serverFieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create your workspace" subtitle="One place for your team's tasks, tickets and goals">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {formError && <ErrorNote>{formError}</ErrorNote>}
        <Field label="Workspace name" error={errors.workspaceName}>
          {(id) => <Input id={id} autoFocus placeholder="Acme Inc." value={form.workspaceName} onChange={set('workspaceName')} />}
        </Field>
        <Field label="Your name" error={errors.name}>
          {(id) => <Input id={id} autoComplete="name" value={form.name} onChange={set('name')} />}
        </Field>
        <Field label="Work email" error={errors.email}>
          {(id) => <Input id={id} type="email" autoComplete="email" value={form.email} onChange={set('email')} />}
        </Field>
        <Field label="Password" error={errors.password} hint="At least 10 characters">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Create workspace
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="text-fg underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
