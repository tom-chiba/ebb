import { error, json } from '@sveltejs/kit';
import { requireAuthedDb, requireJsonContentType } from '$lib/server/api';
import { archiveMemo, getMemo, handleMemoError, updateMemo } from '$lib/server/memos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, platform, params }) => {
	const { user, db } = requireAuthedDb({ locals, platform });
	try {
		const memo = await getMemo(db, user.id, params.id);
		return json(memo);
	} catch (err) {
		handleMemoError(err);
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
	const { user, db } = requireAuthedDb({ locals, platform });
	requireJsonContentType(request);

	const rawBody = await request.json().catch(() => null);
	const body = parseUpdateMemoBody(rawBody);
	if (!body) {
		error(400, 'title, content and intervalPresetId, when present, must be strings');
	}

	try {
		const memo = await updateMemo(db, user.id, params.id, body);
		return json(memo);
	} catch (err) {
		handleMemoError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	const { user, db } = requireAuthedDb({ locals, platform });
	try {
		await archiveMemo(db, user.id, params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		handleMemoError(err);
	}
};
