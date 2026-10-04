import { describe, expect, it } from 'vitest';
import { parsePaginationParam } from './pagination';

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
