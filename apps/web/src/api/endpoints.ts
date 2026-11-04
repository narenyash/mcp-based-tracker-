import type {
  AcceptInviteInput,
  AssignableUserDto,
  BoardDto,
  CreateLabelInput,
  CreateTaskInput,
  LabelDto,
  ListTasksQuery,
  MoveTaskInput,
  NotificationDto,
  NotificationPrefsDto,
  UpdatePreferencesInput,
  TaskDto,
  UpdateTaskInput,
  CreateInviteInput,
  CreateProjectInput,
  InviteDto,
  InvitePreviewDto,
  LoginInput,
  Page,
  ProjectDto,
  ProjectMemberDto,
  ProjectRole,
  ProjectStatus,
  Role,
  SessionResponse,
  SignupInput,
  UpdateProjectInput,
  UserDto,
} from '@teamtrack/shared';
import { api } from './client';

const ifMatch = (version: number) => ({ headers: { 'If-Match': `"${version}"` } });

export const authApi = {
  login: (input: LoginInput) => api.post<SessionResponse>('/auth/login', input).then((r) => r.data),
  signup: (input: SignupInput) => api.post<SessionResponse>('/auth/signup', input).then((r) => r.data),
  logout: () => api.post('/auth/logout'),
  logoutAll: () => api.post('/auth/logout-all'),
};

export const invitesApi = {
  preview: (token: string) => api.get<InvitePreviewDto>(`/invites/${token}/preview`).then((r) => r.data),
  accept: (input: AcceptInviteInput) => api.post<SessionResponse>('/invites/accept', input).then((r) => r.data),
  list: () => api.get<{ items: InviteDto[] }>('/invites').then((r) => r.data.items),
  create: (input: CreateInviteInput) => api.post<InviteDto>('/invites', input).then((r) => r.data),
  revoke: (id: string) => api.delete(`/invites/${id}`),
};

export const usersApi = {
  list: (params: { q?: string; cursor?: string; limit?: number }) =>
    api.get<Page<UserDto>>('/users', { params }).then((r) => r.data),
  updateMe: (name: string, version: number) => api.patch<UserDto>('/users/me', { name }, ifMatch(version)).then((r) => r.data),
  preferences: () => api.get<NotificationPrefsDto>('/users/me/preferences').then((r) => r.data),
  updatePreferences: (input: UpdatePreferencesInput) => api.patch<NotificationPrefsDto>('/users/me/preferences', input).then((r) => r.data),
  setRole: (id: string, role: Role) => api.patch<UserDto>(`/users/${id}/role`, { role }).then((r) => r.data),
  setStatus: (id: string, status: 'active' | 'suspended') =>
    api.patch<UserDto>(`/users/${id}/status`, { status }).then((r) => r.data),
};

export const projectsApi = {
  list: (params: { status: ProjectStatus; cursor?: string }) =>
    api.get<Page<ProjectDto>>('/projects', { params }).then((r) => r.data),
  get: (id: string) => api.get<ProjectDto>(`/projects/${id}`).then((r) => r.data),
  create: (input: Partial<CreateProjectInput>) => api.post<ProjectDto>('/projects', input).then((r) => r.data),
  update: (id: string, input: UpdateProjectInput, version: number) =>
    api.patch<ProjectDto>(`/projects/${id}`, input, ifMatch(version)).then((r) => r.data),
  remove: (id: string) => api.delete(`/projects/${id}`),
  assignable: (id: string) => api.get<{ items: AssignableUserDto[] }>(`/projects/${id}/assignable`).then((r) => r.data.items),
  members: (id: string) => api.get<{ items: ProjectMemberDto[] }>(`/projects/${id}/members`).then((r) => r.data.items),
  addMember: (id: string, userId: string, role: ProjectRole) => api.post(`/projects/${id}/members`, { userId, role }),
  setMemberRole: (id: string, userId: string, role: ProjectRole) => api.patch(`/projects/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => api.delete(`/projects/${id}/members/${userId}`),
};

/** Query params for GET /tasks (all optional on the client; the server applies defaults). */
export type TaskListParams = Partial<Omit<ListTasksQuery, 'cursor'>> & { cursor?: string | undefined };

export const tasksApi = {
  board: (projectId: string) => api.get<BoardDto>(`/projects/${projectId}/board`).then((r) => r.data),
  list: (params: TaskListParams) => api.get<Page<TaskDto>>('/tasks', { params }).then((r) => r.data),
  get: (id: string) => api.get<TaskDto>(`/tasks/${id}`).then((r) => r.data),
  create: (projectId: string, input: Partial<CreateTaskInput> & { title: string }) =>
    api.post<TaskDto>(`/projects/${projectId}/tasks`, input).then((r) => r.data),
  update: (id: string, input: UpdateTaskInput, version: number) =>
    api.patch<TaskDto>(`/tasks/${id}`, input, ifMatch(version)).then((r) => r.data),
  move: (id: string, input: MoveTaskInput, version: number) =>
    api.patch<TaskDto>(`/tasks/${id}/move`, input, ifMatch(version)).then((r) => r.data),
  remove: (id: string) => api.delete(`/tasks/${id}`),
  addChecklistItem: (id: string, text: string) => api.post<TaskDto>(`/tasks/${id}/checklist`, { text }).then((r) => r.data),
  updateChecklistItem: (id: string, itemId: string, input: { text?: string; done?: boolean }) =>
    api.patch<TaskDto>(`/tasks/${id}/checklist/${itemId}`, input).then((r) => r.data),
  removeChecklistItem: (id: string, itemId: string) => api.delete<TaskDto>(`/tasks/${id}/checklist/${itemId}`).then((r) => r.data),
};

export const labelsApi = {
  list: (projectId: string) => api.get<{ items: LabelDto[] }>(`/projects/${projectId}/labels`).then((r) => r.data.items),
  create: (projectId: string, input: Partial<CreateLabelInput> & { name: string }) =>
    api.post<LabelDto>(`/projects/${projectId}/labels`, input).then((r) => r.data),
  remove: (projectId: string, labelId: string) => api.delete(`/projects/${projectId}/labels/${labelId}`),
};

export const notificationsApi = {
  list: (params: { cursor?: string; limit?: number; unread?: boolean }) =>
    api.get<Page<NotificationDto>>('/notifications', { params }).then((r) => r.data),
  unreadCount: () => api.get<{ count: number }>('/notifications/unread-count').then((r) => r.data.count),
  markRead: (id: string) => api.post(`/notifications/${id}/read`),
  markAllRead: () => api.post('/notifications/read-all'),
};
