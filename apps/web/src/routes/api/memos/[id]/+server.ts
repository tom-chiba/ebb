import { error, json } from '@sveltejs/kit';
import { createDb } from '@ebb/db';
import {
	archiveMemo,
	getMemo,
	NotFoundError,
	updateMemo,
	ValidationError
} from '$lib/server/memos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, platform, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform?.env.DB) error(500, 'platform.env.DB is not available');

	const db = createDb(platform.env.DB);
	try {
		const memo = await getMemo(db, locals.user.id, params.id);
		return json(memo);
	} catch (err) {
		if (err instanceof NotFoundError) error(404, 'Not Found');
		throw err;
	}
};

function parseUpdateMemoBody(body: unknown) {
	if (typeof body !== 'object' || body === null) return null;
	const record = body as Record<string, unknown>;
	if (record.title !== undefined && typeof record.title !== 'string') return null;
	if (record.content !== undefined && typeof record.content !== 'string') return null;
	if (record.intervalPresetId !== undefined && typeof record.intervalPresetId !== 'string') {
		return null;
	}
	return {
		title: record.title as string | undefined,
		content: record.content as string | undefined,
		intervalPresetId: record.intervalPresetId as string | undefined
	};
}

export const PATCH: RequestHandler = async ({ locals, platform, params, request }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform?.env.DB) error(500, 'platform.env.DB is not available');
	if (request.headers.get('content-type') !== 'application/json') {
		error(400, 'content-type must be application/json');
	}

	const rawBody = await request.json().catch(() => null);
	const body = parseUpdateMemoBody(rawBody);
	if (!body) {
		error(400, 'title, content and intervalPresetId, when present, must be strings');
	}

	const db = createDb(platform.env.DB);
	try {
		const memo = await updateMemo(db, locals.user.id, params.id, body);
		return json(memo);
	} catch (err) {
		if (err instanceof ValidationError) error(400, err.message);
		if (err instanceof NotFoundError) error(404, 'Not Found');
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform?.env.DB) error(500, 'platform.env.DB is not available');

	const db = createDb(platform.env.DB);
	try {
		await archiveMemo(db, locals.user.id, params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		if (err instanceof NotFoundError) error(404, 'Not Found');
		throw err;
	}
};
