import type {
  EntityType,
  NotificationType,
  ProjectRole,
  ProjectStatus,
  ProjectVisibility,
  Role,
  StatusCategory,
  TaskPriority,
  TestResult,
  UserStatus,
} from './enums';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** RFC 7807 problem details, as returned by every error response. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
  [extra: string]: unknown;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  version: number;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
  workspace: WorkspaceDto;
}

export interface InviteDto {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

export interface JoinLinkDto {
  url: string;
  expiresAt: string;
  useCount: number;
}

export interface InvitePreviewDto {
  /** Null for a team join link: the person joining enters their own email. */
  email: string | null;
  role: Role;
  workspaceName: string;
}

export interface WorkflowStatusDto {
  id: string;
  name: string;
  category: StatusCategory;
  color: string;
  order: number;
}

export interface ProjectDto {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  leadId: string;
  memberCount: number;
  workflow: { taskStatuses: WorkflowStatusDto[]; ticketStatuses: WorkflowStatusDto[] };
  myRole: ProjectRole | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Someone who can be given work in a project. `isMember: false` means they'll be added on assignment. */
export interface AssignableUserDto {
  userId: string;
  name: string;
  email: string;
  isMember: boolean;
}

export interface ProjectMemberDto {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: ProjectRole;
  addedAt: string;
}

/** Minimal user reference embedded in other DTOs. */
export interface PersonRef {
  id: string;
  name: string;
}

export interface ChecklistItemDto {
  id: string;
  text: string;
  done: boolean;
}

/** One trip through a testing status. `round` counts how many times the task was sent to testing. */
export interface TestingDto {
  round: number;
  result: TestResult;
  sentAt: string;
  sentBy: PersonRef | null;
  resultAt: string | null;
  resultBy: PersonRef | null;
  note: string;
}

export interface TaskDto {
  id: string;
  key: string;
  number: number;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  statusId: string;
  statusCategory: StatusCategory;
  priority: TaskPriority;
  assignee: PersonRef | null;
  tester: PersonRef | null;
  reporter: PersonRef | null;
  labelIds: string[];
  /** YYYY-MM-DD */
  dueDate: string | null;
  completedAt: string | null;
  rank: string;
  checklist: ChecklistItemDto[];
  counts: { subtasks: number; subtasksDone: number; checklist: number; checklistDone: number };
  testing: TestingDto | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface BoardDto {
  tasks: TaskDto[];
  /** True when the project has more top-level tasks than one board load returns. */
  truncated: boolean;
}

export interface LabelDto {
  id: string;
  name: string;
  color: string;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  /** Usually the task title. */
  body: string;
  note: string;
  /** In-app path, e.g. /projects/:id?task=:taskId */
  path: string;
  actor: PersonRef | null;
  entityType: EntityType | null;
  /** Readable key of the thing it is about, e.g. WEB-12 or TCK-3. */
  entityKey: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPrefsDto {
  email: { assigned: boolean; testing: boolean; dueSoon: boolean; mentioned: boolean };
}
