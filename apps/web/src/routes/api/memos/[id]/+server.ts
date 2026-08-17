import { error, json } from '@sveltejs/kit';
import { requireAuthedDb, requireJsonContentType } from '$lib/server/api';
import { handleDomainError } from '$lib/server/errors';
import { archiveMemo, changeMemoPreset, getMemo, updateMemo } from '$lib/server/memos';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, platform, params }) => {
	const { user, db } = requireAuthedDb({ locals, platform });
	try {
		const memo = await getMemo(db, user.id, params.id);
		return json(memo);
	} catch (err) {
		handleDomainError(err);
	}
};

function parseUpdateMemoBody(body: unknown) {
	if (typeof body !== 'object' || body === null) return null;
	const record = body as Record<string, unknown>;
	if (typeof record.expectedUpdatedAt !== 'string') return null;
	const expectedUpdatedAt = new Date(record.expectedUpdatedAt);
	if (Number.isNaN(expectedUpdatedAt.getTime())) return null;
	if (record.title !== undefined && typeof record.title !== 'string') return null;
	if (record.content !== undefined && typeof record.content !== 'string') return null;
	if (record.intervalPresetId !== undefined && typeof record.intervalPresetId !== 'string') {
		return null;
	}
	return {
		expectedUpdatedAt,
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
		error(
			400,
			'expectedUpdatedAt (ISO string of the last-known updatedAt) is required; title, content and intervalPresetId, when present, must be strings'
		);
	}

	try {
		const { expectedUpdatedAt, ...input } = body;
		// intervalPresetId が含まれるリクエストのみ changeMemoPreset（プリセット変更、
		// reviews の再計算を伴う）に回す。省略された場合は updateMemo（title/content
		// のみ、reviews には一切触れない）のまま（#82、プリセット変更を通常の
		// メモ更新から分離する設計）。
		const memo =
			input.intervalPresetId !== undefined
				? await changeMemoPreset(db, user.id, params.id, expectedUpdatedAt, {
						title: input.title,
						content: input.content,
						intervalPresetId: input.intervalPresetId
					})
				: await updateMemo(db, user.id, params.id, expectedUpdatedAt, {
						title: input.title,
						content: input.content
					});
		return json(memo);
	} catch (err) {
		handleDomainError(err);
	}
};

export const DELETE: RequestHandler = async ({ locals, platform, params }) => {
	const { user, db } = requireAuthedDb({ locals, platform });
	try {
		await archiveMemo(db, user.id, params.id);
		return new Response(null, { status: 204 });
	} catch (err) {
		handleDomainError(err);
	}
};
