import { describe, expect, test } from 'vitest';
import { createDetailRequestGuard } from './detailRequestGuard';

describe('detail request guard', () => {
	test('accepts only the latest request sequence', () => {
		const guard = createDetailRequestGuard();
		const first = guard.next();
		const second = guard.next();

		expect(guard.isCurrent(first)).toBe(false);
		expect(guard.isCurrent(second)).toBe(true);
	});

	test('invalidates in-flight requests when closed', () => {
		const guard = createDetailRequestGuard();
		const inFlight = guard.next();
		guard.invalidate();

		expect(guard.isCurrent(inFlight)).toBe(false);
		expect(guard.isCurrent(guard.next())).toBe(true);
	});
});
