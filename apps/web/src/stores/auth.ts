import { create } from 'zustand';
import type { SessionResponse, UserDto, WorkspaceDto } from '@teamtrack/shared';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: Status;
  /** Access token lives in memory only; the refresh token is an httpOnly cookie. */
  accessToken: string | null;
  user: UserDto | null;
  workspace: WorkspaceDto | null;
  setSession: (s: SessionResponse) => void;
  setUser: (u: UserDto) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  workspace: null,
  setSession: (s) => set({ status: 'authenticated', accessToken: s.accessToken, user: s.user, workspace: s.workspace }),
  setUser: (user) => set({ user }),
  clear: () => set({ status: 'anonymous', accessToken: null, user: null, workspace: null }),
}));
