import { useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CircleCheck, Link2 } from 'lucide-react';
import { hasRoleAtLeast, type LabelDto, type ProjectDto, type TicketDto, type WorkflowStatusDto } from '@teamtrack/shared';
import { ticketsApi } from '../../api/tickets';
import { useAuth } from '../../stores/auth';
import { errorMessage } from '../../lib/errors';
import { useLabels } from '../../lib/tasks';
import { canEditProject, RESOLUTION_LABEL, sortedTicketStatuses, tk } from '../../lib/tickets';
import { Avatar, cx, ErrorNote, Spinner } from '../ui';
import { LabelChip, StatusDot } from '../task/bits';
import { SeverityIcon, TypeIcon } from './bits';
import { useMoveTicket } from './useMoveTicket';

export function TicketBoard({ project, onOpen }: { project: ProjectDto; onOpen: (ticketId: string) => void }) {
  const role = useAuth((s) => s.user?.role ?? 'guest');
  const board = useQuery({ queryKey: tk.board(project.id), queryFn: () => ticketsApi.board(project.id) });
  const labels = useLabels(project.id);
  const { requestMove, dialog } = useMoveTicket(project);
  const statuses = useMemo(() => sortedTicketStatuses(project), [project]);
  const statusIds = useMemo(() => new Set(statuses.map((s) => s.id)), [statuses]);
  const canEdit = canEditProject(project, hasRoleAtLeast(role, 'admin'));

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tickets = useMemo(() => board.data?.tickets ?? [], [board.data]);
  const columns = useMemo(() => new Map(statuses.map((s) => [s.id, tickets.filter((t) => t.statusId === s.id)])), [statuses, tickets]);
  const labelById = useMemo(() => new Map((labels.data ?? []).map((l) => [l.id, l])), [labels.data]);
  const columnOf = (id: string) => (statusIds.has(id) ? id : tickets.find((t) => t.id === id)?.statusId);

  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    const found = hits.length ? hits : rectIntersection(args);
    const card = found.find((h) => !statusIds.has(String(h.id)));
    return card ? [card] : found.slice(0, 1);
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    setOverColumn(null);
    if (!over) return;
    const ticket = tickets.find((t) => t.id === active.id);
    const targetId = columnOf(String(over.id));
    const status = statuses.find((s) => s.id === targetId);
    if (!ticket || !status) return;

    const original = columns.get(status.id) ?? [];
    let list: TicketDto[];
    let index: number;
    if (ticket.statusId === status.id) {
      const from = original.findIndex((t) => t.id === ticket.id);
      const to = over.id === status.id ? original.length - 1 : original.findIndex((t) => t.id === over.id);
      if (from === to || to < 0) return;
      list = arrayMove(original, from, to);
      index = to;
    } else {
      list = [...original];
      const overIndex = list.findIndex((t) => t.id === over.id);
      index = overIndex === -1 ? list.length : overIndex;
      list.splice(index, 0, ticket);
    }
    requestMove(ticket, status, { afterId: list[index - 1]?.id ?? null, beforeId: list[index + 1]?.id ?? null });
  }

  if (board.isPending) return <Spinner />;
  if (board.isError) return <ErrorNote>{errorMessage(board.error)}</ErrorNote>;
  const active = activeId ? tickets.find((t) => t.id === activeId) : undefined;

  return (
    <>
      {board.data.truncated && <p className="mb-3 text-xs text-muted">Showing the first 1,000 tickets. Use the List view and filters to find older ones.</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(e) => setActiveId(String(e.active.id))}
        onDragOver={(e) => setOverColumn(e.over ? (columnOf(String(e.over.id)) ?? null) : null)}
        onDragCancel={() => {
          setActiveId(null);
          setOverColumn(null);
        }}
        onDragEnd={onDragEnd}
      >
        <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-6 sm:-mx-8 sm:px-8">
          {statuses.map((s) => (
            <Column
              key={s.id}
              status={s}
              tickets={columns.get(s.id) ?? []}
              labelById={labelById}
              canEdit={canEdit}
              highlighted={overColumn === s.id && active?.statusId !== s.id}
              onOpen={onOpen}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>{active && <Card ticket={active} labelById={labelById} dragging />}</DragOverlay>
      </DndContext>
      {dialog}
    </>
  );
}

function Column({
  status,
  tickets,
  labelById,
  canEdit,
  highlighted,
  onOpen,
}: {
  status: WorkflowStatusDto;
  tickets: TicketDto[];
  labelById: Map<string, LabelDto>;
  canEdit: boolean;
  highlighted: boolean;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: status.id, disabled: !canEdit });
  return (
    <section className="flex w-72 shrink-0 flex-col" aria-label={status.name}>
      <header className="mb-2 flex items-center gap-2 px-1">
        <StatusDot color={status.color} />
        <h3 className="text-xs font-medium">{status.name}</h3>
        <span className="text-xs text-subtle tabular-nums">{tickets.length}</span>
        {status.category === 'done' && (
          <span title="Moving a ticket here asks for a resolution" className="ml-auto text-subtle">
            <CircleCheck className="size-3.5" />
          </span>
        )}
      </header>
      <div ref={setNodeRef} className={cx('flex min-h-32 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors', highlighted ? 'bg-hover' : 'bg-surface')}>
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.map((t) => (
            <SortableCard key={t.id} ticket={t} labelById={labelById} disabled={!canEdit} onOpen={onOpen} />
          ))}
        </SortableContext>
      </div>
    </section>
  );
}

function SortableCard({ ticket, labelById, disabled, onOpen }: { ticket: TicketDto; labelById: Map<string, LabelDto>; disabled: boolean; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: ticket.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') onOpen(ticket.id);
        else listeners?.onKeyDown?.(e);
      }}
      onClick={() => onOpen(ticket.id)}
    >
      <Card ticket={ticket} labelById={labelById} />
    </div>
  );
}

function Card({ ticket: t, labelById, dragging }: { ticket: TicketDto; labelById: Map<string, LabelDto>; dragging?: boolean }) {
  const ticketLabels = t.labelIds.flatMap((id) => labelById.get(id) ?? []);
  return (
    <article
      className={cx(
        'cursor-pointer rounded-md border border-border bg-bg p-2.5 hover:border-subtle',
        dragging && 'rotate-1 cursor-grabbing shadow-lg',
        t.statusCategory === 'done' && 'text-muted',
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-snug break-words">{t.title}</p>
        {t.assignee && (
          <span title={`Assigned to ${t.assignee.name}`}>
            <Avatar name={t.assignee.name} size={20} />
          </span>
        )}
      </div>
      {ticketLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {ticketLabels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-subtle">
        <TypeIcon type={t.type} />
        <span className="job-tag">{t.key}</span>
        <SeverityIcon severity={t.severity} />
        {t.linkedTasks.length > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums" title="Linked tasks">
            <Link2 className="size-3" />
            {t.linkedTasks.length}
          </span>
        )}
        {t.resolution && <span className="ml-auto">{RESOLUTION_LABEL[t.resolution]}</span>}
      </div>
    </article>
  );
}
