import { error } from '@sveltejs/kit';
import { createDb } from '@ebb/db';
import { NotFoundError, ValidationError } from '$lib/server/memos';
import type { RequestEvent } from '@sveltejs/kit';

export function requireAuthedDb(event: Pick<RequestEvent, 'locals' | 'platform'>) {
	if (!event.locals.user) error(401, 'Unauthorized');
	if (!event.platform?.env.DB) error(500, 'platform.env.DB is not available');
	return { user: event.locals.user, db: createDb(event.platform.env.DB) };
}

export function requireJsonContentType(request: Request) {
	const contentType = request.headers.get('content-type') ?? '';
	// `application/json; charset=utf-8` のようなパラメータ付きの値も許容するため、
	// 先頭のメディアタイプだけを比較する。
	if ((contentType.split(';')[0] ?? '').trim() !== 'application/json') {
		error(400, 'content-type must be application/json');
	}
}

// ValidationError はクライアント自身の入力に関する情報なのでメッセージをそのまま返す。
// NotFoundError は「存在しない」と「他人のもの」を区別させないため、常に固定文言にする。
export function handleMemoError(err: unknown): never {
	if (err instanceof ValidationError) error(400, err.message);
	if (err instanceof NotFoundError) error(404, 'Not Found');
	throw err;
}
