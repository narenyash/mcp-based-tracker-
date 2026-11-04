import { useState } from 'react';
import { matchPath, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BarChart3, CalendarDays, CircleCheck, FolderKanban, Home, LifeBuoy, LogOut, Menu, MessageSquareText, PenTool, Settings, Target, Users } from 'lucide-react';
import { useAuth } from '../stores/auth';
import { authApi } from '../api/endpoints';
import { endSession } from '../api/client';
import { Avatar, cx } from './ui';
import { NotificationBell } from './NotificationBell';
import { useRealtime } from '../lib/realtime';
import { CommandPalette } from './CommandPalette';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/my-work', label: 'My work', icon: CircleCheck, end: false },
  { to: '/projects', label: 'Projects', icon: FolderKanban, end: false },
  { to: '/tickets', label: 'Tickets', icon: LifeBuoy, end: false },
  { to: '/goals', label: 'Goals', icon: Target, end: false },
  { to: '/boards', label: 'Whiteboards', icon: PenTool, end: false },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, end: false },
  { to: '/standups', label: 'Standups', icon: MessageSquareText, end: false },
  { to: '/reports', label: 'Reports', icon: BarChart3, end: false },
  { to: '/team', label: 'Team', icon: Users, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
];

/** Pages that need the full width (boards, calendars); everything else keeps a readable measure. */
const WIDE = ['/projects/:id', '/tickets', '/calendar', '/boards/:id'];

export function AppShell() {
  const user = useAuth((s) => s.user);
  const workspace = useAuth((s) => s.workspace);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useRealtime();
  const { pathname } = useLocation();
  const wide = WIDE.some((p) => matchPath(p, pathname));

  const signOut = async () => {
    try {
      await authApi.logout();
    } finally {
      endSession();
      navigate('/login');
    }
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-start gap-2 pt-1 pl-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{workspace?.name}</p>
          <p className="text-xs text-subtle">TeamTrack</p>
        </div>
        <span className="hidden md:block">
          <NotificationBell />
        </span>
      </div>
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-hover font-medium' : 'text-muted hover:bg-hover hover:text-fg')
          }
        >
          <Icon className="size-4" strokeWidth={1.75} />
          {label}
        </NavLink>
      ))}
      <div className="mt-auto flex items-center gap-2 rounded-md px-2 py-2">
        <Avatar name={user?.name ?? '?'} size={26} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{user?.name}</p>
          <p className="truncate text-xs text-subtle capitalize">{user?.role}</p>
        </div>
        <button onClick={() => void signOut()} className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Sign out" title="Sign out">
          <LogOut className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <CommandPalette />
      <aside className="hidden w-56 shrink-0 border-r border-border bg-surface md:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border px-4 md:hidden">
          <button onClick={() => setOpen(true)} className="rounded p-1.5 hover:bg-hover" aria-label="Open menu">
            <Menu className="size-4" />
          </button>
          <span className="flex-1 text-sm font-medium">{workspace?.name}</span>
          <NotificationBell />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className={cx('mx-auto px-4 py-8 sm:px-8', wide ? 'max-w-[110rem]' : 'max-w-5xl')}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
