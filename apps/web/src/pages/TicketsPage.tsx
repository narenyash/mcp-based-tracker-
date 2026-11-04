import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { hasRoleAtLeast } from '@teamtrack/shared';
import { useAuth } from '../stores/auth';
import { errorMessage } from '../lib/errors';
import { useProjectRoom } from '../lib/realtime';
import { canEditProject, useActiveProjects } from '../lib/tickets';
import { Button, EmptyState, ErrorNote, PageHeader, Select, Spinner, Tabs } from '../components/ui';
import { TicketList } from '../components/ticket/TicketList';
import { TicketBoard } from '../components/ticket/TicketBoard';
import { TicketDrawer } from '../components/ticket/TicketDrawer';
import { NewTicketDialog } from '../components/ticket/NewTicketDialog';

type View = 'list' | 'board';

/** Workspace-wide tickets: a list across projects, or one project's board. View, project and open ticket live in the URL. */
export function TicketsPage() {
  const isAdmin = useAuth((s) => hasRoleAtLeast(s.user?.role ?? 'guest', 'admin'));
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'board' ? 'board' : 'list';
  const projectParam = params.get('project');
  const openTicketId = params.get('ticket');
  const [creating, setCreating] = useState(false);

  const projectsQuery = useActiveProjects();
  const projects = projectsQuery.data?.items ?? [];
  const project = projects.find((p) => p.id === projectParam) ?? null;
  // The board needs a project; fall back to the first one rather than showing nothing.
  const boardProject = view === 'board' ? (project ?? projects[0] ?? null) : null;
  const writable = projects.filter((p) => canEditProject(p, isAdmin));

  const update = (change: (next: URLSearchParams) => void) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      change(next);
      return next;
    });
  const setView = (v: View) =>
    update((next) => {
      if (v === 'list') next.delete('view');
      else {
        next.set('view', v);
        if (!project && projects[0]) next.set('project', projects[0].id);
      }
    });
  const setProject = (id: string) => update((next) => (id ? next.set('project', id) : next.delete('project')));
  const openTicket = (id: string | null) => update((next) => (id ? next.set('ticket', id) : next.delete('ticket')));

  // Live updates for the project in view (lib/realtime refreshes the ticket caches).
  useProjectRoom(boardProject?.id ?? project?.id ?? '');

  return (
    <>
      <PageHeader
        title="Tickets"
        description="Bugs, issues and requests across your projects"
        actions={
          <>
            {projects.length > 0 && (
              <Select aria-label="Project" className="w-48" value={view === 'board' ? (boardProject?.id ?? '') : (project?.id ?? '')} onChange={(e) => setProject(e.target.value)}>
                {view === 'list' && <option value="">All projects</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="primary" onClick={() => setCreating(true)} disabled={writable.length === 0} title={writable.length === 0 ? 'You need to be a member of an active project' : undefined}>
              <Plus className="size-4" />
              New ticket
            </Button>
          </>
        }
      />
      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { value: 'list', label: 'List' },
          { value: 'board', label: 'Board' },
        ]}
      />

      {projectsQuery.isPending ? (
        <Spinner />
      ) : projectsQuery.isError ? (
        <ErrorNote>{errorMessage(projectsQuery.error)}</ErrorNote>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Tickets belong to a project. Create or join a project to start tracking tickets." />
      ) : view === 'board' && boardProject ? (
        <TicketBoard key={boardProject.id} project={boardProject} onOpen={openTicket} />
      ) : (
        <TicketList projectId={project?.id ?? null} projects={projects} onOpen={openTicket} />
      )}

      {creating && (
        <NewTicketDialog
          projects={writable}
          defaultProjectId={writable.find((p) => p.id === (project ?? boardProject)?.id)?.id ?? null}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            openTicket(t.id);
          }}
        />
      )}
      {openTicketId && <TicketDrawer ticketId={openTicketId} onClose={() => openTicket(null)} />}
    </>
  );
}
