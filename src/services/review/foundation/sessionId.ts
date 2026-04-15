import { REVIEW_LIMITS, ReviewError } from '../errors.js';

export const SESSION_ID_PATTERN = /^[a-zA-Z0-9_:-]{1,256}$/;

export function validateSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId.length > REVIEW_LIMITS.MAX_SESSION_ID_LENGTH ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new ReviewError('E002', `Invalid sessionId: "${sessionId}"`);
  }
}
