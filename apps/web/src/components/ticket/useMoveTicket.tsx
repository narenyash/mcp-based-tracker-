import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TICKET_RESOLUTIONS, type MoveTicketInput, type ProjectDto, type TicketBoardDto, type TicketDto, type TicketResolution, type WorkflowStatusDto } from '@teamtrack/shared';
import { ticketsApi } from '../../api/tickets';
import { toastError } from '../../stores/toast';
import { errorMessage, problemOf } from '../../lib/errors';
import { RESOLUTION_LABEL, syncTicket, tk } from '../../lib/tickets';
import { Button, Dialog, Field, Select, Textarea } from '../ui';

export interface Position {
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
}

interface PendingMove {
  ticket: TicketDto;
  status: WorkflowStatusDto;
  position: Position;
}

/** Reorders the cached board as the server will, so a drop feels instant. */
function applyMove(board: TicketBoardDto, ticketId: string, status: WorkflowStatusDto, pos: Position): TicketBoardDto {
  const moving = board.tickets.find((t) => t.id === ticketId);
  if (!moving) return board;
  const rest = board.tickets.filter((t) => t.id !== ticketId);
  let at: number;
  if (pos.afterId) at = rest.findIndex((t) => t.id === pos.afterId) + 1;
  else if (pos.beforeId) at = Math.max(rest.findIndex((t) => t.id === pos.beforeId), 0);
  else {
    const last = rest.map((t) => t.statusId).lastIndexOf(status.id);
    at = last === -1 ? rest.length : last + 1;
  }
  rest.splice(at, 0, { ...moving, statusId: status.id, statusCategory: status.category });
  return { ...board, tickets: rest };
}

/**
 * Ticket status changes with the resolution rule applied on the client too: moving an open ticket to
 * a done status asks why it is being closed. The server enforces the same rule.
 */
export function useMoveTicket(project: ProjectDto) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingMove | null>(null);

  const latestVersion = (t: TicketDto) => {
    const cached = qc.getQueryData<TicketDto>(tk.ticket(t.id))?.version ?? 0;
    const onBoard = qc.getQueryData<TicketBoardDto>(tk.board(project.id))?.tickets.find((x) => x.id === t.id)?.version ?? 0;
    return Math.max(t.version, cached, onBoard);
  };

  const mutation = useMutation({
    mutationFn: ({ ticket, input }: { ticket: TicketDto; status: WorkflowStatusDto; input: MoveTicketInput }) =>
      ticketsApi.move(ticket.id, input, latestVersion(ticket)),
    onMutate: async ({ ticket, status, input }) => {
      await qc.cancelQueries({ queryKey: tk.board(project.id) });
      const previous = qc.getQueryData<TicketBoardDto>(tk.board(project.id));
      if (previous) qc.setQueryData(tk.board(project.id), applyMove(previous, ticket.id, status, input));
      return { previous };
    },
    onError: (err, { ticket }, context) => {
      if (context?.previous) qc.setQueryData(tk.board(project.id), context.previous);
      const code = problemOf(err)?.code;
      if (code === 'STALE_VERSION' || code === 'CONFLICT') {
        void qc.invalidateQueries({ queryKey: tk.board(project.id) });
        void qc.invalidateQueries({ queryKey: tk.ticket(ticket.id) });
      }
      toastError(errorMessage(err));
    },
    onSuccess: (ticket) => syncTicket(qc, ticket),
  });

  const run = (ticket: TicketDto, status: WorkflowStatusDto, position: Position, extra: Pick<MoveTicketInput, 'resolution' | 'note'> = {}) =>
    mutation.mutate({ ticket, status, input: { statusId: status.id, ...position, ...extra } });

  function requestMove(ticket: TicketDto, status: WorkflowStatusDto, position: Position = {}): void {
    const resolving = status.id !== ticket.statusId && status.category === 'done' && ticket.statusCategory !== 'done';
    if (resolving) return setPending({ ticket, status, position });
    run(ticket, status, position);
  }

  const dialog = pending && (
    <ResolveDialog
      key={pending.ticket.id}
      pending={pending}
      onClose={() => setPending(null)}
      onConfirm={(extra) => {
        run(pending.ticket, pending.status, pending.position, extra);
        setPending(null);
      }}
    />
  );

  return { requestMove, dialog, isMoving: mutation.isPending };
}

function ResolveDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: PendingMove;
  onClose: () => void;
  onConfirm: (extra: { resolution: TicketResolution; note?: string }) => void;
}) {
  const { ticket, status } = pending;
  const [resolution, setResolution] = useState<TicketResolution | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!resolution) return setError('Choose a resolution');
    onConfirm({ resolution, ...(note.trim() ? { note: note.trim() } : {}) });
  };

  return (
    <Dialog open onClose={onClose} title={`Move ${ticket.key} to ${status.name}`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Resolution" error={error}>
          {(id) => (
            <Select id={id} value={resolution} onChange={(e) => setResolution(e.target.value as TicketResolution)} autoFocus>
              <option value="">Choose…</option>
              {TICKET_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {RESOLUTION_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Note" hint={ticket.reporter ? `Optional. ${ticket.reporter.name} will see this.` : 'Optional.'}>
          {(id) => <Textarea id={id} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Resolve
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
