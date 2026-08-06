import { describe, expect, it } from 'vitest';
import { excerptOf } from './excerpt';

describe('excerptOf', () => {
	it('returns short content unchanged', () => {
		expect(excerptOf('hello world')).toBe('hello world');
	});

	it('flattens runs of whitespace, including newlines, into single spaces', () => {
		expect(excerptOf('line1\n\nline2\t line3')).toBe('line1 line2 line3');
	});

	it('truncates long content at 80 code points and appends an ellipsis', () => {
		const long = 'a'.repeat(100);
		const out = excerptOf(long);
		expect(out).toBe(`${'a'.repeat(80)}…`);
	});

	it('does not split a surrogate pair straddling the truncation boundary', () => {
		// 79 個の 'a' + 絵文字（サロゲートペア、2 UTF-16 コード単位）で
		// ちょうど 80 文字目に絵文字がまたがる状況を作る。
		const content = 'a'.repeat(79) + '😀' + 'b'.repeat(20);
		const out = excerptOf(content);
		expect(out).toBe(`${'a'.repeat(79)}😀…`);
		// 分断された不正なサロゲートを含まないことも確認する。
		expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});
});
