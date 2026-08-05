import { error, json } from '@sveltejs/kit';
import { requireAuthedDb, requireJsonContentType } from '$lib/server/api';
import { createMemo, handleMemoError, listMemos } from '$lib/server/memos';
import { parsePaginationParam } from '$lib/server/pagination';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	const { user, db } = requireAuthedDb({ locals, platform });

	const limit = parsePaginationParam(url.searchParams.get('limit'));
	const offset = parsePaginationParam(url.searchParams.get('offset'));
	if (limit === 'invalid' || offset === 'invalid') {
		error(400, 'limit and offset must be non-negative integers');
	}

	const result = await listMemos(db, user.id, { limit, offset });
	return json(result);
};

function parseCreateMemoBody(body: unknown) {
	if (typeof body !== 'object' || body === null) return null;
	const record = body as Record<string, unknown>;
	if (record.id !== undefined && typeof record.id !== 'string') return null;
	if (
		typeof record.title !== 'string' ||
		typeof record.content !== 'string' ||
		typeof record.intervalPresetId !== 'string'
	) {
		return null;
	}
	return {
		id: record.id as string | undefined,
		title: record.title,
		content: record.content,
		intervalPresetId: record.intervalPresetId
	};
}

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	const { user, db } = requireAuthedDb({ locals, platform });
	requireJsonContentType(request);

	const rawBody = await request.json().catch(() => null);
	const body = parseCreateMemoBody(rawBody);
	if (!body) {
		error(400, 'title, content and intervalPresetId are required strings');
	}

	try {
		const memo = await createMemo(db, user.id, body);
		return json(memo, { status: 201 });
	} catch (err) {
		handleMemoError(err);
	}
};
