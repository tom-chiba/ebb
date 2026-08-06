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
