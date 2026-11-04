import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { acceptInviteSchema } from '@teamtrack/shared';
import { invitesApi } from '../api/endpoints';
import { applySession } from '../api/client';
import { AuthCard } from '../components/guards';
import { Button, ErrorNote, Field, Input, Spinner } from '../components/ui';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../lib/errors';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => invitesApi.preview(token), retry: false });
  const [form, setForm] = useState({ name: '', password: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  if (preview.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <AuthCard title="This invite link isn't valid" subtitle="It may have expired, been used already, or been replaced by a newer invite">
        <Link to="/login" className="text-sm underline underline-offset-4">
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const v = validate(acceptInviteSchema, { ...form, token });
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    setBusy(true);
    try {
      applySession(await invitesApi.accept(v.data));
      navigate('/', { replace: true });
    } catch (err) {
      setErrors(serverFieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={`Join ${preview.data.workspaceName}`} subtitle={`You've been invited as a ${preview.data.role}.`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {formError && <ErrorNote>{formError}</ErrorNote>}
        <Field label="Email">{(id) => <Input id={id} value={preview.data.email} disabled />}</Field>
        <Field label="Your name" error={errors.name}>
          {(id) => <Input id={id} autoFocus autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        </Field>
        <Field label="Choose a password" error={errors.password} hint="At least 10 characters">
          {(id) => (
            <Input id={id} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          )}
        </Field>
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Join workspace
        </Button>
      </form>
    </AuthCard>
  );
}
