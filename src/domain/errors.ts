export type StatusHint = 'not_found' | 'validation' | 'timeout' | 'internal';

export class GnosisError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusHint: StatusHint = 'internal',
  ) {
    super(message);
    this.name = 'GnosisError';
  }
}

export class NotFoundError extends GnosisError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 'not_found');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends GnosisError {
  constructor(message: string) {
    super(message, 'VALIDATION', 'validation');
    this.name = 'ValidationError';
  }
}

export class TimeoutError extends GnosisError {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`, 'TIMEOUT', 'timeout');
    this.name = 'TimeoutError';
  }
}

export const isGnosisError = (err: unknown): err is GnosisError => err instanceof GnosisError;
