import { describe, expect, test } from 'bun:test';
import {
  GnosisError,
  NotFoundError,
  TimeoutError,
  ValidationError,
  isGnosisError,
} from '../src/domain/errors';

describe('domain/errors', () => {
  test('GnosisError has correct properties', () => {
    const err = new GnosisError('something went wrong', 'INTERNAL');
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe('INTERNAL');
    expect(err.statusHint).toBe('internal');
    expect(err.name).toBe('GnosisError');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof GnosisError).toBe(true);
  });

  test('NotFoundError has correct properties', () => {
    const err = new NotFoundError('memory', 'abc-123');
    expect(err.message).toBe('memory not found: abc-123');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusHint).toBe('not_found');
    expect(err.name).toBe('NotFoundError');
    expect(err instanceof GnosisError).toBe(true);
  });

  test('ValidationError has correct properties', () => {
    const err = new ValidationError('field is required');
    expect(err.message).toBe('field is required');
    expect(err.code).toBe('VALIDATION');
    expect(err.statusHint).toBe('validation');
    expect(err.name).toBe('ValidationError');
    expect(err instanceof GnosisError).toBe(true);
  });

  test('TimeoutError has correct properties', () => {
    const err = new TimeoutError('embed', 5000);
    expect(err.message).toBe('embed timed out after 5000ms');
    expect(err.code).toBe('TIMEOUT');
    expect(err.statusHint).toBe('timeout');
    expect(err.name).toBe('TimeoutError');
    expect(err instanceof GnosisError).toBe(true);
  });

  test('isGnosisError returns true for GnosisError subclasses', () => {
    expect(isGnosisError(new GnosisError('x', 'X'))).toBe(true);
    expect(isGnosisError(new NotFoundError('r', 'id'))).toBe(true);
    expect(isGnosisError(new ValidationError('bad'))).toBe(true);
    expect(isGnosisError(new TimeoutError('op', 1000))).toBe(true);
  });

  test('isGnosisError returns false for plain Error', () => {
    expect(isGnosisError(new Error('plain'))).toBe(false);
    expect(isGnosisError('string error')).toBe(false);
    expect(isGnosisError(null)).toBe(false);
  });
});
