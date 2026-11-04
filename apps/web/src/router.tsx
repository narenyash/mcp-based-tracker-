import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppShell } from './components/AppShell';
import { RedirectIfAuthed, RequireAuth } from './components/guards';
import { LoginPage } from './pages/LoginPage';

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-sm font-medium">Page not found</p>
      <Link to="/" className="text-sm text-muted underline underline-offset-4">
        Go home
      </Link>
    </div>
  );
}

/** Shown in place of a page that crashed, inside the shell so the sidebar still works. */
function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  console.error(error);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-24 text-center">
      <p className="text-sm font-medium">Something went wrong on this page</p>
      <p className="text-sm text-muted">
        {error instanceof Error ? error.message : 'Unexpected error'}
      </p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 text-sm text-muted underline underline-offset-4 hover:text-fg"
      >
        Reload
      </button>
    </div>
  );
}

// Route-level code splitting: each page is its own chunk, loaded on first visit.
export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <RedirectIfAuthed>
        <LoginPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: '/signup',
    lazy: async () => {
      const { SignupPage } = await import('./pages/SignupPage');
      return {
        element: (
          <RedirectIfAuthed>
            <SignupPage />
          </RedirectIfAuthed>
        ),
      };
    },
  },
  {
    path: '/invite/:token',
    lazy: async () => ({ Component: (await import('./pages/AcceptInvitePage')).AcceptInvitePage }),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      {
        // Pathless: a crash in one page renders here, keeping the shell around it.
        errorElement: <RouteError />,
        children: [
          {
            index: true,
            lazy: async () => ({
              Component: (await import('./pages/DashboardPage')).DashboardPage,
            }),
          },
          {
            path: 'my-work',
            lazy: async () => ({ Component: (await import('./pages/MyWorkPage')).MyWorkPage }),
          },
          {
            path: 'projects',
            lazy: async () => ({ Component: (await import('./pages/ProjectsPage')).ProjectsPage }),
          },
          {
            path: 'projects/:id',
            lazy: async () => ({
              Component: (await import('./pages/ProjectDetailPage')).ProjectDetailPage,
            }),
          },
          {
            path: 'tickets',
            lazy: async () => ({ Component: (await import('./pages/TicketsPage')).TicketsPage }),
          },
          {
            path: 'goals',
            lazy: async () => ({ Component: (await import('./pages/GoalsPage')).GoalsPage }),
          },
          {
            path: 'boards',
            lazy: async () => ({ Component: (await import('./pages/BoardsPage')).BoardsPage }),
          },
          {
            path: 'boards/:id',
            lazy: async () => ({ Component: (await import('./pages/BoardPage')).BoardPage }),
          },
          {
            path: 'calendar',
            lazy: async () => ({ Component: (await import('./pages/CalendarPage')).CalendarPage }),
          },
          {
            path: 'standups',
            lazy: async () => ({ Component: (await import('./pages/StandupsPage')).StandupsPage }),
          },
          {
            path: 'reports',
            lazy: async () => ({ Component: (await import('./pages/ReportsPage')).ReportsPage }),
          },
          {
            path: 'team',
            lazy: async () => ({ Component: (await import('./pages/TeamPage')).TeamPage }),
          },
          {
            path: 'settings',
            lazy: async () => ({ Component: (await import('./pages/SettingsPage')).SettingsPage }),
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
