import { error } from '@sveltejs/kit';

// memos・reviews 等、複数のドメインで共通して使うエラー分類。#13 では memos.ts に
// 置いていたが、reviews（#17）という2つ目の消費者ができた時点で「memo 固有」という
// 位置づけが実態と合わなくなったため、共有モジュールに切り出した。
export class ValidationError extends Error {}
export class NotFoundError extends Error {}
// 楽観的並行性制御で、更新対象が最後に読んだ状態から変わっていた場合に投げる。
export class ConflictError extends Error {}

// ValidationError はクライアント自身の入力に関する情報なのでメッセージをそのまま返す。
// NotFoundError は「存在しない」と「他人のもの」を区別させないため、常に固定文言にする。
// ConflictError はクライアントに再取得の上でのリトライを促すため 409 にする。
export function handleDomainError(err: unknown): never {
	if (err instanceof ValidationError) error(400, err.message);
	if (err instanceof NotFoundError) error(404, 'Not Found');
	if (err instanceof ConflictError) error(409, err.message);
	throw err;
}

// indexHint で該当テーブル/カラムのユニーク制約違反かを絞り込む。単に
// "UNIQUE constraint failed" だけを見ると、同じ操作内で複数のユニーク制約
// （例: memos.id と reviews_memoId_step_unique）が存在する場合に取り違える。
// memos.ts（#16 の createMemo 冪等性チェック）と interval-presets.ts（#18 の
// updateCustomPresetIntervals、db.batch() の SELECT-then-write 間の競合検出）の
// 2箇所から使う共通ロジックのため、こちらに置く。
export function isUniqueConstraintViolation(err: unknown, indexHint: string): boolean {
	if (!(err instanceof Error)) return false;
	const cause = err.cause instanceof Error ? err.cause.message : '';
	const message = `${err.message} ${cause}`;
	return /UNIQUE constraint failed/i.test(message) && message.includes(indexHint);
}
