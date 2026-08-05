import { describe, expect, it } from 'vitest';
import { normalizeLineEndings } from './text';

describe('normalizeLineEndings', () => {
	it('converts CRLF to LF', () => {
		expect(normalizeLineEndings('a\r\nb\r\nc')).toBe('a\nb\nc');
	});

	it('leaves already-LF text unchanged', () => {
		expect(normalizeLineEndings('a\nb\nc')).toBe('a\nb\nc');
	});

	it('leaves text without line breaks unchanged', () => {
		expect(normalizeLineEndings('abc')).toBe('abc');
	});
});
