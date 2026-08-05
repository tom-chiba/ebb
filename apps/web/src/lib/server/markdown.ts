import MarkdownIt from 'markdown-it';

// html: false（既定値）により、本文中の生 HTML タグは常にエスケープされ描画されない。
// <script> を含む本文を保存しても実行されないという要件を、レンダラの設定だけで
// 構造的に満たす（Workers ランタイムに DOM が無いため DOMPurify 等は使えない）。
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

export function renderMarkdown(content: string): string {
	return md.render(content);
}
