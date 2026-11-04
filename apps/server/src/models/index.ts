import { Counter } from './Counter';
import { EmailLog } from './EmailLog';
import { IdempotencyKey } from './IdempotencyKey';
import { Invite } from './Invite';
import { JobLock } from './JobLock';
import { Label } from './Label';
import { Notification } from './Notification';
import { Outbox } from './Outbox';
import { Project } from './Project';
import { ProjectMember } from './ProjectMember';
import { RateLimitHit } from './RateLimitHit';
import { Session } from './Session';
import { SnakeScore } from './SnakeScore';
import { Task } from './Task';
import { User } from './User';
import { Workspace } from './Workspace';
import { TICKETS_MODELS } from '../modules/tickets/models';
import { COLLAB_MODELS } from '../modules/collab/models';
import { GOALS_MODELS } from '../modules/goals/models';
import { BOARDS_MODELS } from '../modules/boards/models';
import { PLANNING_MODELS } from '../modules/planning/models';
import { REPORTS_MODELS } from '../modules/reports/models';

export { Counter, EmailLog, IdempotencyKey, Invite, JobLock, Label, Notification, Outbox, Project, ProjectMember, RateLimitHit, Session, SnakeScore, Task, User, Workspace };

/** Every model the migration runner manages indexes for. */
export const ALL_MODELS = [
  Workspace,
  User,
  Session,
  Invite,
  Project,
  ProjectMember,
  Task,
  Label,
  Counter,
  Outbox,
  EmailLog,
  RateLimitHit,
  IdempotencyKey,
  SnakeScore,
  Notification,
  JobLock,
  ...TICKETS_MODELS,
  ...COLLAB_MODELS,
  ...GOALS_MODELS,
  ...BOARDS_MODELS,
  ...PLANNING_MODELS,
  ...REPORTS_MODELS,
];
