export function formatDateTime(date: Date): string {
	return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatTime(date: Date): string {
	return new Intl.DateTimeFormat('ja-JP', { timeStyle: 'short' }).format(date);
}

// メモ一覧・詳細の「次回 8/12 8:00」表示用の短い日時表記。formatDateTime の
// dateStyle: 'medium'（例: 2026年8月12日）は一覧の1行に収めるには冗長なため、
// 月日+時刻のみの別フォーマッタとして分ける。
export function formatShortDateTime(date: Date): string {
	return new Intl.DateTimeFormat('ja-JP', {
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	}).format(date);
}
