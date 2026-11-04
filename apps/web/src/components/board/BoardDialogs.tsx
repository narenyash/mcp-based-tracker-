import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createWhiteboardSchema, hasRoleAtLeast, updateWhiteboardSchema, type WhiteboardDto } from '@teamtrack/shared';
import { boardsApi } from '../../api/boards';
import { bk } from '../../lib/boards';
import { errorMessage, serverFieldErrors, validate, type FieldErrors } from '../../lib/errors';
import { canEditProject, useActiveProjects } from '../../lib/tickets';
import { useAuth } from '../../stores/auth';
import { Button, Dialog, ErrorNote, Field, Input, Select } from '../ui';

export function CreateBoardDialog({ open, onClose, defaultProjectId }: { open: boolean; onClose: () => void; defaultProjectId?: string | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = useAuth((s) => hasRoleAtLeast(s.user?.role ?? 'guest', 'admin'));
  const projects = (useActiveProjects().data?.items ?? []).filter((p) => canEditProject(p, isAdmin));
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const selected = projectId || (projects.some((p) => p.id === defaultProjectId) ? defaultProjectId! : (projects[0]?.id ?? ''));

  const create = useMutation({
    mutationFn: boardsApi.create,
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: bk.lists });
      close();
      navigate(`/boards/${b.id}`);
    },
    onError: (err) => setErrors({ ...serverFieldErrors(err), _form: errorMessage(err) }),
  });

  const close = () => {
    setTitle('');
    setProjectId('');
    setErrors({});
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(createWhiteboardSchema, { title, projectId: selected });
    if ('errors' in v) return setErrors(v.errors);
    setErrors({});
    create.mutate(v.data);
  };

  return (
    <Dialog open={open} onClose={close} title="New whiteboard">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {errors._form && <ErrorNote>{errors._form}</ErrorNote>}
        <Field label="Title" error={errors.title}>
          {(id) => <Input id={id} autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Architecture sketch" />}
        </Field>
        <Field label="Project" error={errors.projectId} hint={projects.length ? undefined : 'You need to be a member of an active project to create a board.'}>
          {(id) => (
            <Select id={id} value={selected} onChange={(e) => setProjectId(e.target.value)} disabled={!projects.length}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!projects.length}>
            Create board
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RenameBoardDialog({ board, onClose }: { board: WhiteboardDto | null; onClose: () => void }) {
  return (
    <Dialog open={!!board} onClose={onClose} title="Rename whiteboard">
      {board && <RenameForm key={board.id} board={board} onClose={onClose} />}
    </Dialog>
  );
}

function RenameForm({ board, onClose }: { board: WhiteboardDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(board.title);
  const [errors, setErrors] = useState<FieldErrors>({});
  const rename = useMutation({
    mutationFn: (t: string) => boardsApi.rename(board.id, t, board.version),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: bk.lists });
      qc.setQueryData(bk.board(b.id), (old: object | undefined) => old && { ...old, ...b });
      onClose();
    },
    onError: (err) => setErrors({ ...serverFieldErrors(err), _form: errorMessage(err) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate(updateWhiteboardSchema, { title });
    if ('errors' in v) return setErrors(v.errors);
    rename.mutate(v.data.title);
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {errors._form && <ErrorNote>{errors._form}</ErrorNote>}
      <Field label="Title" error={errors.title}>
        {(id) => <Input id={id} autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function DeleteBoardDialog({ board, onClose, onDeleted }: { board: WhiteboardDto | null; onClose: () => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => boardsApi.remove(id),
    onSuccess: (_r, id) => {
      void qc.invalidateQueries({ queryKey: bk.lists });
      qc.removeQueries({ queryKey: bk.board(id) });
      onClose();
      onDeleted?.();
    },
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={!!board} onClose={close} title="Delete whiteboard">
      {board && (
        <div className="space-y-4">
          {remove.isError && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
          <p className="text-sm text-muted">
            Delete <span className="font-medium text-fg">{board.title}</span>? Its drawing, history and discussion go with it.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(board.id)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
