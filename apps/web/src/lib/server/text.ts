// ブラウザはフォーム送信（application/x-www-form-urlencoded / multipart）時に
// <textarea> の改行を CRLF に正規化する（HTML 標準の仕様）。一方でクライアント側の
// maxlength はライブの DOM 値（LF）で文字数を数えるため、改行を多く含む本文を
// ブラウザ上でちょうど上限まで入力できても、送信後は CRLF 化された分だけ文字数が
// 増えてサーバー側の文字数上限チェックに弾かれてしまう。保存前に LF へ正規化し、
// また /api/memos（JSON、CRLF化されない）経由の保存と本文の改行コードが揃うようにする。
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n');
}
