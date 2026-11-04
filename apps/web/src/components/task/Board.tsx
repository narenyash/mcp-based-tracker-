import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { FlaskConical, ListChecks, ListTree, Plus } from 'lucide-react';
import { hasRoleAtLeast, type LabelDto, type ProjectDto, type TaskDto, type WorkflowStatusDto } from '@teamtrack/shared';
import { tasksApi } from '../../api/endpoints';
import { useAuth } from '../../stores/auth';
import { toastError } from '../../stores/toast';
import { errorMessage } from '../../lib/errors';
import { firstName, qk, refreshProjectTasks, sortedStatuses, useLabels } from '../../lib/tasks';
import { Avatar, cx, ErrorNote, Spinner } from '../ui';
import { DueDate, LabelChip, PriorityIcon, StatusDot, TestingBadge } from './bits';
import { useMoveTask } from './useMoveTask';

export function Board({ project, onOpen }: { project: ProjectDto; onOpen: (taskId: string) => void }) {
  const role = useAuth((s) => s.user?.role ?? 'guest');
  const board = useQuery({ queryKey: qk.board(project.id), queryFn: () => tasksApi.board(project.id) });
  const labels = useLabels(project.id);
  const { requestMove, dialog } = useMoveTask(project);
  const statuses = useMemo(() => sortedStatuses(project), [project]);
  const statusIds = useMemo(() => new Set(statuses.map((s) => s.id)), [statuses]);
  const canEdit = project.status === 'active' && (hasRoleAtLeast(role, 'admin') || project.myRole === 'lead' || project.myRole === 'member');

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const sensors = useSensors(
    // A small distance keeps plain clicks as clicks (open the task) rather than drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tasks = useMemo(() => board.data?.tasks ?? [], [board.data]);
  const columns = useMemo(() => new Map(statuses.map((s) => [s.id, tasks.filter((t) => t.statusId === s.id)])), [statuses, tasks]);
  const labelById = useMemo(() => new Map((labels.data ?? []).map((l) => [l.id, l])), [labels.data]);
  const columnOf = (id: string) => (statusIds.has(id) ? id : tasks.find((t) => t.id === id)?.statusId);

  // Prefer the card under the pointer over its column; fall back to the column (empty space) or overlap.
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
    const task = tasks.find((t) => t.id === active.id);
    const targetId = columnOf(String(over.id));
    const status = statuses.find((s) => s.id === targetId);
    if (!task || !status) return;

    const original = columns.get(status.id) ?? [];
    let list: TaskDto[];
    let index: number;
    if (task.statusId === status.id) {
      const from = original.findIndex((t) => t.id === task.id);
      const to = over.id === status.id ? original.length - 1 : original.findIndex((t) => t.id === over.id);
      if (from === to || to < 0) return;
      list = arrayMove(original, from, to);
      index = to;
    } else {
      list = [...original];
      const overIndex = list.findIndex((t) => t.id === over.id);
      index = overIndex === -1 ? list.length : overIndex;
      list.splice(index, 0, task);
    }
    requestMove(task, status, { afterId: list[index - 1]?.id ?? null, beforeId: list[index + 1]?.id ?? null });
  }

  if (board.isPending) return <Spinner />;
  if (board.isError) return <ErrorNote>{errorMessage(board.error)}</ErrorNote>;
  const active = activeId ? tasks.find((t) => t.id === activeId) : undefined;

  return (
    <>
      {board.data.truncated && (
        <p className="mb-3 text-xs text-muted">Showing the first 1,000 cards. Use the List view and filters to find older tasks.</p>
      )}
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
              project={project}
              status={s}
              tasks={columns.get(s.id) ?? []}
              labelById={labelById}
              canEdit={canEdit}
              highlighted={overColumn === s.id && active?.statusId !== s.id}
              onOpen={onOpen}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>{active && <Card task={active} labelById={labelById} dragging />}</DragOverlay>
      </DndContext>
      {dialog}
    </>
  );
}

function Column({
  project,
  status,
  tasks,
  labelById,
  canEdit,
  highlighted,
  onOpen,
}: {
  project: ProjectDto;
  status: WorkflowStatusDto;
  tasks: TaskDto[];
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
        <span className="text-xs text-subtle tabular-nums">{tasks.length}</span>
        {status.category === 'testing' && (
          <span title="Moving a task here asks who will test it" className="ml-auto text-subtle">
            <FlaskConical className="size-3.5" />
          </span>
        )}
      </header>
      <div
        ref={setNodeRef}
        className={cx('flex min-h-32 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors', highlighted ? 'bg-hover' : 'bg-surface')}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <SortableCard key={t.id} task={t} labelById={labelById} disabled={!canEdit} onOpen={onOpen} />
          ))}
        </SortableContext>
        {canEdit && status.category !== 'testing' && <QuickAdd project={project} status={status} />}
      </div>
    </section>
  );
}

function SortableCard({ task, labelById, disabled, onOpen }: { task: TaskDto; labelById: Map<string, LabelDto>; disabled: boolean; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
      // dnd-kit's attributes make the card focusable; Enter opens it, Space starts a keyboard drag.
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') onOpen(task.id);
        else listeners?.onKeyDown?.(e);
      }}
      onClick={() => onOpen(task.id)}
    >
      <Card task={task} labelById={labelById} />
    </div>
  );
}

function Card({ task, labelById, dragging }: { task: TaskDto; labelById: Map<string, LabelDto>; dragging?: boolean }) {
  const taskLabels = task.labelIds.flatMap((id) => labelById.get(id) ?? []);
  return (
    <article
      className={cx(
        'cursor-pointer rounded-md border border-border bg-bg p-2.5 hover:border-subtle',
        dragging && 'rotate-1 cursor-grabbing shadow-lg',
        task.statusCategory === 'done' && 'text-muted',
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] leading-snug break-words">{task.title}</p>
        {task.assignee && (
          <span title={`Assigned to ${task.assignee.name}`}>
            <Avatar name={task.assignee.name} size={20} />
          </span>
        )}
      </div>
      {taskLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {taskLabels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-subtle">
        <span className="job-tag">{task.key}</span>
        <PriorityIcon priority={task.priority} />
        <DueDate task={task} />
        {task.counts.subtasks > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums" title="Subtasks done">
            <ListTree className="size-3" />
            {task.counts.subtasksDone}/{task.counts.subtasks}
          </span>
        )}
        {task.counts.checklist > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums" title="Checklist">
            <ListChecks className="size-3" />
            {task.counts.checklistDone}/{task.counts.checklist}
          </span>
        )}
        {task.reporter && (
          <span className="ml-auto truncate" title={`Created by ${task.reporter.name}`}>
            by {firstName(task.reporter.name)}
          </span>
        )}
      </div>
      {task.testing && (
        <div className="mt-1.5">
          <TestingBadge task={task} />
        </div>
      )}
    </article>
  );
}

function QuickAdd({ project, status }: { project: ProjectDto; status: WorkflowStatusDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: (t: string) => tasksApi.create(project.id, { title: t, statusId: status.id }),
    onSuccess: () => {
      setTitle('');
      refreshProjectTasks(qc, project.id);
      input.current?.focus();
    },
    onError: (err) => toastError(errorMessage(err)),
  });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg">
        <Plus className="size-3.5" />
        Add task
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate(title.trim());
      }}
    >
      <input
        ref={input}
        autoFocus
        value={title}
        maxLength={200}
        disabled={create.isPending}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !title.trim() && setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && (setTitle(''), setOpen(false))}
        placeholder="Task title, then Enter"
        className="w-full rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] placeholder:text-subtle focus:border-fg focus:outline-none"
      />
    </form>
  );
}
