export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, AppError);
  }
}

export const BadRequest = (msg = 'Bad request', details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const Unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const Forbidden = (msg = 'Not allowed') => new AppError(403, 'FORBIDDEN', msg);
export const NotFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const Conflict = (msg = 'Conflicting state', details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const PlanLimit = (msg: string) => new AppError(402, 'PLAN_LIMIT', msg);
