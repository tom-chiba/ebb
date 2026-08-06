const EXCERPT_LENGTH = 80;

export function excerptOf(content: string): string {
	const flat = content.replace(/\s+/g, ' ').trim();
	// String#slice は UTF-16 コード単位で切るため、絵文字等のサロゲートペア文字が
	// ちょうど境界にあると片方だけ残って文字化けする。Array.from はコードポイント
	// 単位でイテレートするため、この境界を跨がない。
	const codePoints = Array.from(flat);
	return codePoints.length > EXCERPT_LENGTH
		? `${codePoints.slice(0, EXCERPT_LENGTH).join('')}…`
		: flat;
}
