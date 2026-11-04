import { ERROR_CODES, type ErrorCode } from '@teamtrack/shared';

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(public readonly errors: FieldError[]) {
    super(400, ERROR_CODES.VALIDATION_FAILED, 'Request validation failed', { errors });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCode = ERROR_CODES.UNAUTHENTICATED) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this', code: ErrorCode = ERROR_CODES.FORBIDDEN) {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, ERROR_CODES.NOT_FOUND, `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = ERROR_CODES.CONFLICT, extra: Record<string, unknown> = {}) {
    super(409, code, message, extra);
  }
}

export class StaleVersionError extends ConflictError {
  constructor() {
    super('This item was changed by someone else. Reload and try again.', ERROR_CODES.STALE_VERSION);
  }
}

export class PreconditionRequiredError extends AppError {
  constructor() {
    super(428, ERROR_CODES.PRECONDITION_REQUIRED, 'If-Match header with the current version is required');
  }
}
