import { error } from '@sveltejs/kit';
import { createDb } from '@ebb/db';
import type { RequestEvent } from '@sveltejs/kit';

export function requireAuthedDb(event: Pick<RequestEvent, 'locals' | 'platform'>) {
	if (!event.locals.user) error(401, 'Unauthorized');
	if (!event.platform?.env.DB) error(500, 'platform.env.DB is not available');
	return { user: event.locals.user, db: createDb(event.platform.env.DB) };
}

export function requireJsonContentType(request: Request) {
	const contentType = request.headers.get('content-type') ?? '';
	// `application/json; charset=utf-8` のようなパラメータ付きの値も許容し、
	// メディアタイプ自体は大文字小文字を区別しない（RFC 9110）ため、
	// 先頭のメディアタイプだけを小文字化して比較する。
	if ((contentType.split(';')[0] ?? '').trim().toLowerCase() !== 'application/json') {
		error(400, 'content-type must be application/json');
	}
}
