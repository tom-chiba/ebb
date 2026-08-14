import { describe, expect, it } from 'vitest';
import { applyMarkdownToolbarAction } from './markdown-toolbar';

describe('applyMarkdownToolbarAction', () => {
	describe('heading', () => {
		it('adds a leading "# " to the current line', () => {
			const result = applyMarkdownToolbarAction('heading', { value: 'title', start: 0, end: 0 });
			expect(result).toEqual({ value: '# title', start: 2, end: 2 });
		});

		it('toggles off an existing heading marker', () => {
			const result = applyMarkdownToolbarAction('heading', {
				value: '# title',
				start: 7,
				end: 7
			});
			expect(result).toEqual({ value: 'title', start: 5, end: 5 });
		});

		it('only affects the line containing the cursor', () => {
			const value = 'first\nsecond';
			const cursor = value.indexOf('second');
			const result = applyMarkdownToolbarAction('heading', {
				value,
				start: cursor,
				end: cursor
			});
			expect(result.value).toBe('first\n# second');
		});
	});

	describe('bullet', () => {
		it('adds a leading "- "', () => {
			const result = applyMarkdownToolbarAction('bullet', { value: 'item', start: 0, end: 0 });
			expect(result).toEqual({ value: '- item', start: 2, end: 2 });
		});

		it('does nothing when the line already has a bullet', () => {
			const result = applyMarkdownToolbarAction('bullet', {
				value: '- item',
				start: 3,
				end: 3
			});
			expect(result).toEqual({ value: '- item', start: 3, end: 3 });
		});
	});

	describe('quote', () => {
		it('adds a leading "> "', () => {
			const result = applyMarkdownToolbarAction('quote', { value: 'quote', start: 0, end: 0 });
			expect(result).toEqual({ value: '> quote', start: 2, end: 2 });
		});

		it('does nothing when the line already has a quote marker', () => {
			const result = applyMarkdownToolbarAction('quote', {
				value: '> quote',
				start: 3,
				end: 3
			});
			expect(result).toEqual({ value: '> quote', start: 3, end: 3 });
		});
	});

	describe('bold', () => {
		it('wraps the selection', () => {
			const result = applyMarkdownToolbarAction('bold', {
				value: 'hello world',
				start: 6,
				end: 11
			});
			expect(result).toEqual({ value: 'hello **world**', start: 8, end: 13 });
		});

		it('inserts an empty pair with the caret centered when there is no selection', () => {
			const result = applyMarkdownToolbarAction('bold', { value: 'hello ', start: 6, end: 6 });
			expect(result).toEqual({ value: 'hello ****', start: 8, end: 8 });
		});
	});

	describe('code', () => {
		it('wraps the selection', () => {
			const result = applyMarkdownToolbarAction('code', {
				value: 'run cmd here',
				start: 4,
				end: 7
			});
			expect(result).toEqual({ value: 'run `cmd` here', start: 5, end: 8 });
		});

		it('inserts an empty pair with the caret centered when there is no selection', () => {
			const result = applyMarkdownToolbarAction('code', { value: '', start: 0, end: 0 });
			expect(result).toEqual({ value: '``', start: 1, end: 1 });
		});
	});
});
