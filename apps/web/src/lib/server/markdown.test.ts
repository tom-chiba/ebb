import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('renders headings', () => {
		expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
	});

	it('renders unordered and ordered lists', () => {
		expect(renderMarkdown('- a\n- b')).toContain('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
		expect(renderMarkdown('1. a\n2. b')).toContain('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
	});

	it('renders blockquotes', () => {
		expect(renderMarkdown('> quoted text')).toContain(
			'<blockquote>\n<p>quoted text</p>\n</blockquote>'
		);
	});

	it('renders bold text', () => {
		expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
	});

	it('renders inline code', () => {
		expect(renderMarkdown('`code`')).toContain('<code>code</code>');
	});

	it('renders fenced code blocks without interpreting their contents as markdown', () => {
		const out = renderMarkdown('```\nconst x = 1;\n```');
		expect(out).toContain('<pre><code>const x = 1;\n</code></pre>');
	});

	it('escapes a raw script tag instead of emitting an executable element', () => {
		const out = renderMarkdown('<script>alert(1)</script>');
		expect(out).not.toContain('<script>');
		expect(out).toContain('&lt;script&gt;');
	});

	it('escapes inline HTML mixed into a paragraph', () => {
		const out = renderMarkdown('click <img src=x onerror="alert(1)"> here');
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img');
	});

	it('does not turn a bare javascript: link into a clickable anchor', () => {
		const out = renderMarkdown('javascript:alert(1)');
		expect(out).not.toContain('<a href="javascript:');
	});

	it('drops the href of a markdown link using the javascript: protocol', () => {
		const out = renderMarkdown('[click](javascript:alert(1))');
		expect(out).not.toMatch(/href="javascript:/i);
	});

	it('drops the href of a markdown link using the vbscript: protocol', () => {
		const out = renderMarkdown('[click](vbscript:alert(1))');
		expect(out).not.toMatch(/href="vbscript:/i);
	});

	it('drops the href of a markdown link using a data: URI', () => {
		const out = renderMarkdown('[click](data:text/html,<script>alert(1)</script>)');
		expect(out).not.toMatch(/href="data:/i);
	});

	it('drops the src of a markdown image using the javascript: protocol', () => {
		const out = renderMarkdown('![x](javascript:alert(1))');
		expect(out).not.toMatch(/src="javascript:/i);
	});
});
