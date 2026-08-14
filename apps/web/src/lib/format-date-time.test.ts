import { describe, expect, it } from 'vitest';
import { formatShortDateTime } from './format-date-time';

describe('formatShortDateTime', () => {
	// vitest-pool-workers（workerd）の既定タイムゾーンは UTC
	// （docs/design-decisions.md、apps/web/src/routes/(app)/+page.svelte のコメント参照）。
	it('formats as month/day hour:minute', () => {
		expect(formatShortDateTime(new Date('2026-08-12T08:00:00Z'))).toBe('8/12 8:00');
	});

	it('zero-pads a single-digit minute', () => {
		expect(formatShortDateTime(new Date('2026-01-05T14:05:00Z'))).toBe('1/5 14:05');
	});
});
