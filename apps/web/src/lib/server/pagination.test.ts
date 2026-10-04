import { describe, expect, it } from 'vitest';
import { computeLoadMore, parsePaginationParam } from './pagination';

describe('parsePaginationParam', () => {
	it('returns undefined when the parameter is absent', () => {
		expect(parsePaginationParam(null)).toBeUndefined();
	});

	it('treats an empty string as invalid', () => {
		expect(parsePaginationParam('')).toBe('invalid');
	});

	it('parses a plain non-negative integer', () => {
		expect(parsePaginationParam('20')).toBe(20);
		expect(parsePaginationParam('0')).toBe(0);
	});

	it('rejects a decimal value', () => {
		expect(parsePaginationParam('2.5')).toBe('invalid');
	});

	it('rejects a negative value', () => {
		expect(parsePaginationParam('-1')).toBe('invalid');
	});

	it('rejects exponential notation', () => {
		expect(parsePaginationParam('1e21')).toBe('invalid');
	});

	it('rejects a value too large to be a safe integer', () => {
		expect(parsePaginationParam('99999999999999999999')).toBe('invalid');
	});

	it('rejects non-numeric input', () => {
		expect(parsePaginationParam('abc')).toBe('invalid');
	});
});

describe('computeLoadMore', () => {
	const base = { max: 100, step: 10 };

	it('offers the next step when more items remain', () => {
		expect(computeLoadMore({ ...base, limit: 10, total: 29, shown: 10 })).toEqual({
			limit: 20,
			count: 10
		});
	});

	it('shrinks the count to the remaining items on the last step', () => {
		expect(computeLoadMore({ ...base, limit: 20, total: 29, shown: 20 })).toEqual({
			limit: 30,
			count: 9
		});
	});

	it('returns null when everything is already shown', () => {
		expect(computeLoadMore({ ...base, limit: 10, total: 10, shown: 10 })).toBeNull();
		expect(computeLoadMore({ ...base, limit: 10, total: 0, shown: 0 })).toBeNull();
	});

	it('clamps the last step to the maximum limit', () => {
		expect(computeLoadMore({ ...base, limit: 95, total: 200, shown: 95 })).toEqual({
			limit: 100,
			count: 5
		});
	});

	it('returns null once the limit has reached the maximum', () => {
		expect(computeLoadMore({ ...base, limit: 100, total: 200, shown: 100 })).toBeNull();
	});
});
