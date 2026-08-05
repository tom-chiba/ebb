import { error, json } from '@sveltejs/kit';
import { createDb } from '@ebb/db';
import { createMemo, listMemos, ValidationError } from '$lib/server/memos';
import type { RequestHandler } from './$types';

function parseIntParam(value: string | null) {
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform?.env.DB) error(500, 'platform.env.DB is not available');

	const db = createDb(platform.env.DB);
	const result = await listMemos(db, locals.user.id, {
		limit: parseIntParam(url.searchParams.get('limit')),
		offset: parseIntParam(url.searchParams.get('offset'))
	});
	return json(result);
};

function parseCreateMemoBody(body: unknown) {
	if (typeof body !== 'object' || body === null) return null;
	const record = body as Record<string, unknown>;
	if (
		typeof record.title !== 'string' ||
		typeof record.content !== 'string' ||
		typeof record.intervalPresetId !== 'string'
	) {
		return null;
	}
	return {
		title: record.title,
		content: record.content,
		intervalPresetId: record.intervalPresetId
	};
}

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform?.env.DB) error(500, 'platform.env.DB is not available');
	if (request.headers.get('content-type') !== 'application/json') {
		error(400, 'content-type must be application/json');
	}

	const rawBody = await request.json().catch(() => null);
	const body = parseCreateMemoBody(rawBody);
	if (!body) {
		error(400, 'title, content and intervalPresetId are required strings');
	}

	const db = createDb(platform.env.DB);
	try {
		const memo = await createMemo(db, locals.user.id, body);
		return json(memo, { status: 201 });
	} catch (err) {
		if (err instanceof ValidationError) error(400, err.message);
		throw err;
	}
};
