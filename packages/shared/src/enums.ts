export const ROLES = ['owner', 'admin', 'manager', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { owner: 50, admin: 40, manager: 30, member: 20, guest: 10 };

export function hasRoleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** Roles an actor may grant (via invite or role change). Nobody can grant `owner`. */
export function assignableRoles(actor: Role): Role[] {
  switch (actor) {
    case 'owner':
      return ['admin', 'manager', 'member', 'guest'];
    case 'admin':
      return ['manager', 'member', 'guest'];
    case 'manager':
      return ['member', 'guest'];
    default:
      return [];
  }
}

export const USER_STATUSES = ['invited', 'active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PROJECT_ROLES = ['lead', 'member', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_VISIBILITIES = ['private', 'workspace'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

/**
 * Every workflow status maps to one category. Business rules key off the category, never the
 * (renamable) status: `testing` requires a tester, `done` sets completedAt.
 */
export const STATUS_CATEGORIES = ['todo', 'in_progress', 'testing', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Numeric rank stored next to the priority so lists can sort by it. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

export const TEST_RESULTS = ['pending', 'passed', 'failed'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  WORKSPACE_REQUIRED: 'WORKSPACE_REQUIRED',
  REFRESH_INVALID: 'REFRESH_INVALID',
  CSRF_FAILED: 'CSRF_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_VERSION: 'STALE_VERSION',
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const NOTIFICATION_TYPES = [
  'task_assigned',
  'test_requested',
  'test_failed',
  'test_passed',
  'task_due_soon',
  'task_overdue',
  'ticket_assigned',
  'ticket_resolved',
  'mentioned',
  'comment_added',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Things that can be commented on, have attachments and an activity log, and appear in notifications. */
export const ENTITY_TYPES = ['task', 'ticket', 'goal', 'board'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
