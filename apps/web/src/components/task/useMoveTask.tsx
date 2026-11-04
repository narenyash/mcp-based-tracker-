import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasRoleAtLeast, type BoardDto, type MoveTaskInput, type ProjectDto, type TaskDto, type WorkflowStatusDto } from '@teamtrack/shared';
import { tasksApi } from '../../api/endpoints';
import { useAuth } from '../../stores/auth';
import { toastError } from '../../stores/toast';
import { errorMessage, problemOf } from '../../lib/errors';
import { qk, syncTask, useAssignablePeople } from '../../lib/tasks';
import { Button, Dialog, Field, Select, Textarea } from '../ui';

export interface Position {
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
}

interface PendingMove {
  task: TaskDto;
  status: WorkflowStatusDto;
  position: Position;
  mode: 'send' | 'fail';
}

/** Reorders the cached board as the server will, so a drop feels instant. */
function applyMove(board: BoardDto, taskId: string, status: WorkflowStatusDto, pos: Position): BoardDto {
  const moving = board.tasks.find((t) => t.id === taskId);
  if (!moving) return board;
  const rest = board.tasks.filter((t) => t.id !== taskId);
  let at: number;
  if (pos.afterId) at = rest.findIndex((t) => t.id === pos.afterId) + 1;
  else if (pos.beforeId) at = Math.max(rest.findIndex((t) => t.id === pos.beforeId), 0);
  else {
    // End of the column: right after its current last card (columns are filtered views of one ranked list).
    const last = rest.map((t) => t.statusId).lastIndexOf(status.id);
    at = last === -1 ? rest.length : last + 1;
  }
  rest.splice(at, 0, { ...moving, statusId: status.id, statusCategory: status.category });
  return { ...board, tasks: rest };
}

/**
 * Status changes for a project, with the testing rules applied on the client too:
 * entering a testing column asks who will test; failing a test asks what failed.
 * The server enforces the same rules; this just makes them visible before the request.
 */
export function useMoveTask(project: ProjectDto) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canManage = hasRoleAtLeast(me?.role ?? 'guest', 'admin') || project.myRole === 'lead';
  const [pending, setPending] = useState<PendingMove | null>(null);

  const latestVersion = (t: TaskDto) => {
    const cachedTask = qc.getQueryData<TaskDto>(qk.task(t.id))?.version ?? 0;
    const onBoard = qc.getQueryData<BoardDto>(qk.board(project.id))?.tasks.find((x) => x.id === t.id)?.version ?? 0;
    return Math.max(t.version, cachedTask, onBoard);
  };

  const mutation = useMutation({
    mutationFn: ({ task, input }: { task: TaskDto; status: WorkflowStatusDto; input: MoveTaskInput }) => tasksApi.move(task.id, input, latestVersion(task)),
    onMutate: async ({ task, status, input }) => {
      await qc.cancelQueries({ queryKey: qk.board(project.id) });
      const previous = qc.getQueryData<BoardDto>(qk.board(project.id));
      if (previous) qc.setQueryData(qk.board(project.id), applyMove(previous, task.id, status, input));
      return { previous };
    },
    onError: (err, { task }, context) => {
      if (context?.previous) qc.setQueryData(qk.board(project.id), context.previous);
      const code = problemOf(err)?.code;
      if (code === 'STALE_VERSION' || code === 'CONFLICT') {
        void qc.invalidateQueries({ queryKey: qk.board(project.id) });
        void qc.invalidateQueries({ queryKey: qk.task(task.id) });
      }
      toastError(errorMessage(err));
    },
    onSuccess: (task) => syncTask(qc, task),
  });

  const run = (task: TaskDto, status: WorkflowStatusDto, position: Position, extra: Pick<MoveTaskInput, 'testerId' | 'note'> = {}) =>
    mutation.mutate({ task, status, input: { statusId: status.id, ...position, ...extra } });

  function requestMove(task: TaskDto, status: WorkflowStatusDto, position: Position = {}): void {
    const changing = status.id !== task.statusId;
    const entering = changing && status.category === 'testing' && task.statusCategory !== 'testing';
    const leaving = changing && task.statusCategory === 'testing' && status.category !== 'testing';
    if (leaving && task.tester?.id !== me?.id && !canManage) {
      toastError(`Only ${task.tester?.name ?? 'the tester'} or a project lead can finish testing`);
      return;
    }
    if (entering) return setPending({ task, status, position, mode: 'send' });
    if (leaving && status.category !== 'done') return setPending({ task, status, position, mode: 'fail' });
    run(task, status, position);
  }

  const dialog = pending && (
    <TestingDialog
      key={pending.task.id + pending.mode}
      projectId={project.id}
      pending={pending}
      onClose={() => setPending(null)}
      onConfirm={(extra) => {
        run(pending.task, pending.status, pending.position, extra);
        setPending(null);
      }}
    />
  );

  return { requestMove, dialog, isMoving: mutation.isPending, canManage };
}

function TestingDialog({
  projectId,
  pending,
  onClose,
  onConfirm,
}: {
  projectId: string;
  pending: PendingMove;
  onClose: () => void;
  onConfirm: (extra: { testerId?: string; note?: string }) => void;
}) {
  const { task, status, mode } = pending;
  const { people } = useAssignablePeople(projectId);
  const candidates = people.filter((p) => p.userId !== task.assignee?.id);
  const [testerId, setTesterId] = useState(task.tester && task.tester.id !== task.assignee?.id ? task.tester.id : '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'send' && !testerId) return setError('Choose who will test this task');
    onConfirm({ ...(mode === 'send' ? { testerId } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
  };

  return (
    <Dialog open onClose={onClose} title={mode === 'send' ? `Send ${task.key} to testing` : `${task.key} failed testing`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {mode === 'send' ? (
          <>
            <Field label="Tester" error={error} hint={task.assignee ? `Anyone but ${task.assignee.name}, who did the work.` : undefined}>
              {(id) => (
                <Select id={id} value={testerId} onChange={(e) => setTesterId(e.target.value)} autoFocus>
                  <option value="">Choose a person…</option>
                  {candidates.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                      {p.isMember ? '' : ' (will join the project)'}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Notes for the tester" hint="Optional. What should they check?">
              {(id) => <Textarea id={id} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <p className="text-xs text-muted">They'll get an email. Only they or a project lead can mark it passed or failed.</p>
          </>
        ) : (
          <Field label="What failed?" hint={`Sent back to ${status.name}. ${task.assignee ? `${task.assignee.name} will get this by email.` : ''}`}>
            {(id) => <Textarea id={id} rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {mode === 'send' ? 'Send to testing' : 'Mark as failed'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
