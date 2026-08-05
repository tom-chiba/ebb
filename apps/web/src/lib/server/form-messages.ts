import { CONTENT_MAX_LENGTH, TITLE_MAX_LENGTH } from './memos';

const TITLE_TOO_LONG_RE = /^title must be \d+ characters or fewer$/;
const CONTENT_TOO_LONG_RE = /^content must be \d+ characters or fewer$/;

// メモの作成・編集フォームで使う日本語メッセージを1箇所に集約する。
// new/edit の両 +page.server.ts に同じ文字列を複製しないための置き場所。
export const INVALID_FORM_SUBMISSION_MESSAGE =
	'フォームの内容を読み取れませんでした。ページを再読み込みしてお試しください。';

// $lib/server/memos.ts（#13）の ValidationError はメッセージが英語かつ、内部の
// フィールド名（intervalPresetId 等）がそのまま入っていることがある。UI は日本語で
// 統一しているため、既知のメッセージだけ日本語に翻訳し、それ以外（内部フィールド名を
// 含むものなど）は詳細を漏らさない汎用メッセージにする。
//
// memos.ts のメッセージ文字列と正規表現で結合している。assertTitle/assertContent の
// 文言を変更した場合はこの関数のテスト（form-messages.test.ts）が落ちるので、
// あわせて更新すること。
export function translateMemoValidationMessage(message: string): string {
	if (message === 'title is required') return 'タイトルを入力してください';
	if (TITLE_TOO_LONG_RE.test(message))
		return `タイトルは${TITLE_MAX_LENGTH}文字以内で入力してください`;
	if (CONTENT_TOO_LONG_RE.test(message))
		return `本文は${CONTENT_MAX_LENGTH}文字以内で入力してください`;
	// intervalPresetId 未設定などシステム起因のエラーはここに来るが、専用のUIを
	// 持たないこの画面ではユーザーが取れる対処がないため、汎用メッセージに留める。
	return '入力内容を確認してください';
}
