import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { TICKET_SEVERITIES, TICKET_TYPES, type ProjectDto, type TicketDto, type TicketSeverity, type TicketType, type WorkflowStatusDto } from '@teamtrack/shared';
import { ticketsApi, type TicketListParams } from '../../api/tickets';
import { errorMessage } from '../../lib/errors';
import { useDebounced } from '../../lib/hooks';
import { RESOLUTION_LABEL, SEVERITY_LABEL, tk, TYPE_LABEL } from '../../lib/tickets';
import { Avatar, Button, EmptyState, ErrorNote, Input, Select, Spinner } from '../ui';
import { StatusDot } from '../task/bits';
import { SeverityIcon, TypeIcon } from './bits';

interface Filters {
  q: string;
  state: 'open' | 'done' | 'all';
  person: '' | 'assignee' | 'reporter';
  type: '' | TicketType;
  severity: '' | TicketSeverity;
  sort: 'updated' | 'created' | 'severity';
}

const INITIAL: Filters = { q: '', state: 'open', person: '', type: '', severity: '', sort: 'updated' };

/** Dense ticket rows with filters and infinite scroll. Without a project it lists every visible project. */
export function TicketList({ projectId, projects, onOpen }: { projectId: string | null; projects: ProjectDto[]; onOpen: (ticketId: string) => void }) {
  const [f, setF] = useState<Filters>(INITIAL);
  const q = useDebounced(f.q.trim());
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const params: TicketListParams = {
    state: f.state,
    sort: f.sort,
    limit: 50,
    ...(projectId ? { projectId } : {}),
    ...(q ? { q } : {}),
    ...(f.person === 'assignee' ? { assignee: 'me' } : f.person === 'reporter' ? { reporter: 'me' } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.severity ? { severity: f.severity } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: tk.list(params),
    queryFn: ({ pageParam }) => ticketsApi.list({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const tickets = list.data?.pages.flatMap((p) => p.items) ?? [];
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const filtered = JSON.stringify({ ...f, q }) !== JSON.stringify(INITIAL);

  // Infinite scroll: load the next page when the sentinel under the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search" placeholder="Search title or key, e.g. TCK-12" className="min-w-48 flex-1" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <Select aria-label="State" className="w-28" value={f.state} onChange={(e) => set('state', e.target.value as Filters['state'])}>
          <option value="open">Open</option>
          <option value="done">Resolved</option>
          <option value="all">All</option>
        </Select>
        <Select aria-label="Type" className="w-32" value={f.type} onChange={(e) => set('type', e.target.value as Filters['type'])}>
          <option value="">Any type</option>
          {TICKET_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Severity" className="w-36" value={f.severity} onChange={(e) => set('severity', e.target.value as Filters['severity'])}>
          <option value="">Any severity</option>
          {[...TICKET_SEVERITIES].reverse().map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select aria-label="People" className="w-36" value={f.person} onChange={(e) => set('person', e.target.value as Filters['person'])}>
          <option value="">Anyone</option>
          <option value="assignee">Assigned to me</option>
          <option value="reporter">Reported by me</option>
        </Select>
        <Select aria-label="Sort" className="w-44" value={f.sort} onChange={(e) => set('sort', e.target.value as Filters['sort'])}>
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="severity">Severity</option>
        </Select>
      </div>

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNote>{errorMessage(list.error)}</ErrorNote>
      ) : tickets.length === 0 ? (
        filtered ? (
          <EmptyState title="No tickets match these filters" action={<Button onClick={() => setF(INITIAL)}>Clear filters</Button>} />
        ) : (
          <EmptyState title="No open tickets" description="Bugs, issues and requests reported by your team show up here" />
        )
      ) : (
        <>
          <TicketRows
            tickets={tickets}
            statusOf={(t) => projectById.get(t.projectId)?.workflow.ticketStatuses.find((s) => s.id === t.statusId)}
            projectOf={projectId ? undefined : (t) => projectById.get(t.projectId)}
            onOpen={(t) => onOpen(t.id)}
          />
          <div ref={sentinel} className="flex justify-center">
            {list.hasNextPage && (
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TicketRows({
  tickets,
  statusOf,
  projectOf,
  onOpen,
}: {
  tickets: TicketDto[];
  statusOf: (t: TicketDto) => WorkflowStatusDto | undefined;
  projectOf?: ((t: TicketDto) => { name: string; color: string } | undefined) | undefined;
  onOpen: (t: TicketDto) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {tickets.map((t) => {
        const status = statusOf(t);
        const project = projectOf?.(t);
        return (
          <li key={t.id}>
            <button onClick={() => onOpen(t)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover">
              <TypeIcon type={t.type} />
              <span className="w-20 shrink-0"><span className="job-tag">{t.key}</span></span>
              <span title={`${SEVERITY_LABEL[t.severity]} severity`}>
                <SeverityIcon severity={t.severity} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={t.statusCategory === 'done' ? 'text-sm text-muted' : 'text-sm'}>{t.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {project && (
                    <span className="inline-flex items-center gap-1 text-2xs text-muted">
                      <span className="size-1.5 rounded-full" style={{ background: project.color }} />
                      {project.name}
                    </span>
                  )}
                  {t.resolution && <span className="text-2xs text-muted">{RESOLUTION_LABEL[t.resolution]}</span>}
                  {t.reporter && <span className="text-2xs text-subtle">reported by {t.reporter.name}</span>}
                </span>
              </span>
              <span className="hidden w-28 shrink-0 items-center gap-1.5 text-xs text-muted sm:flex">
                {status && <StatusDot color={status.color} />}
                <span className="truncate">{status?.name ?? t.statusId}</span>
              </span>
              <span className="w-5 shrink-0" title={t.assignee ? `Assigned to ${t.assignee.name}` : 'Unassigned'}>
                {t.assignee ? <Avatar name={t.assignee.name} size={20} /> : <span className="block size-5 rounded-full border border-dashed border-border" />}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
