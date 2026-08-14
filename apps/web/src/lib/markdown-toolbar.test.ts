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

		it('toggles off a multi-level heading marker (##)', () => {
			const result = applyMarkdownToolbarAction('heading', {
				value: '## title',
				start: 8,
				end: 8
			});
			expect(result).toEqual({ value: 'title', start: 5, end: 5 });
		});

		it('does not treat a leading "#" without a following space as a heading marker', () => {
			const result = applyMarkdownToolbarAction('heading', { value: '#tag', start: 0, end: 0 });
			expect(result).toEqual({ value: '# #tag', start: 2, end: 2 });
		});

		it('targets the first (empty) line when the cursor is at position 0 and the text starts with a newline', () => {
			const result = applyMarkdownToolbarAction('heading', {
				value: '\nworld',
				start: 0,
				end: 0
			});
			expect(result).toEqual({ value: '# \nworld', start: 2, end: 2 });
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

		it('does not treat a leading "-" without a following space as a bullet marker', () => {
			const result = applyMarkdownToolbarAction('bullet', {
				value: '-item',
				start: 0,
				end: 0
			});
			expect(result).toEqual({ value: '- -item', start: 2, end: 2 });
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

	describe('multi-line selection', () => {
		it('applies a line-prefix action only to the line containing selectionStart, even when the selection spans multiple lines', () => {
			const value = 'first\nsecond\nthird';
			const start = value.indexOf('second');
			const end = value.indexOf('third') + 'third'.length;
			const result = applyMarkdownToolbarAction('bullet', { value, start, end });
			expect(result.value).toBe('first\n- second\nthird');
		});

		it('wraps a multi-line selection with bold markers around the whole range', () => {
			const value = 'first\nsecond';
			const result = applyMarkdownToolbarAction('bold', { value, start: 0, end: value.length });
			expect(result.value).toBe('**first\nsecond**');
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

		it('inserts an empty pair into an empty document', () => {
			const result = applyMarkdownToolbarAction('bold', { value: '', start: 0, end: 0 });
			expect(result).toEqual({ value: '****', start: 2, end: 2 });
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
