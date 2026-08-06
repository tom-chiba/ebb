import { fail } from '@sveltejs/kit';
import { formatIntervals, MAX_INTERVAL_COUNT } from '@ebb/core';
import { requireAuthedDb } from '$lib/server/api';
import { NotFoundError, ValidationError } from '$lib/server/errors';
import {
	countReviewsAffectedByPresetChange,
	createCustomPreset,
	deleteCustomPreset,
	getDefaultPresetId,
	listPresetsForUser,
	setDefaultPresetForUser,
	updateCustomPresetIntervals
} from '$lib/server/interval-presets';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	const [presets, defaultPresetId] = await Promise.all([
		listPresetsForUser(db, user.id),
		getDefaultPresetId(db, user.id)
	]);
	return {
		presets: presets.map((preset) => ({
			...preset,
			intervalsText: formatIntervals(preset.intervals)
		})),
		defaultPresetId,
		maxIntervalCount: MAX_INTERVAL_COUNT
	};
};

// ValidationError/NotFoundError をフォームアクションの fail() へ変換する。
// handleDomainError（$lib/server/errors）は SvelteKit の error() で投げる前提
// （load・+server.ts 向け）のため、フォームアクションではここで別途変換する。
function presetActionFail(err: unknown, action: string, extra: Record<string, unknown>) {
	if (err instanceof ValidationError) {
		return fail(400, { action, message: err.message, ...extra });
	}
	if (err instanceof NotFoundError) {
		return fail(404, { action, message: 'プリセットが見つかりません', ...extra });
	}
	throw err;
}

export const actions: Actions = {
	createPreset: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const name = form.get('name');
		const intervals = form.get('intervals');
		if (typeof name !== 'string' || typeof intervals !== 'string') {
			return fail(400, { action: 'createPreset', message: '入力が不正です' });
		}
		try {
			await createCustomPreset(db, user.id, name, intervals);
		} catch (err) {
			return presetActionFail(err, 'createPreset', { name, intervals });
		}
		return { action: 'createPreset', success: true };
	},

	// 確認なし（confirmed !== 'true'）の送信では、実際の更新は行わず影響件数の
	// プレビューだけを返す。ユーザーがそれを見て同じフォームを confirmed=true で
	// 再送信した場合にのみ実際に更新する（issue 本文の「変更の影響範囲を明示する」
	// への対応）。
	updatePreset: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const presetId = form.get('presetId');
		const intervals = form.get('intervals');
		const confirmed = form.get('confirmed') === 'true';
		if (typeof presetId !== 'string' || typeof intervals !== 'string') {
			return fail(400, { action: 'updatePreset', message: '入力が不正です' });
		}

		if (!confirmed) {
			try {
				const previewCount = await countReviewsAffectedByPresetChange(db, presetId);
				return { action: 'updatePreset', presetId, intervals, previewCount };
			} catch (err) {
				return presetActionFail(err, 'updatePreset', { presetId, intervals });
			}
		}

		try {
			const { updatedReviewsCount } = await updateCustomPresetIntervals(
				db,
				user.id,
				presetId,
				intervals
			);
			return { action: 'updatePreset', presetId, success: true, updatedReviewsCount };
		} catch (err) {
			return presetActionFail(err, 'updatePreset', { presetId, intervals });
		}
	},

	deletePreset: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const presetId = form.get('presetId');
		if (typeof presetId !== 'string') {
			return fail(400, { action: 'deletePreset', message: '入力が不正です' });
		}
		try {
			await deleteCustomPreset(db, user.id, presetId);
		} catch (err) {
			return presetActionFail(err, 'deletePreset', { presetId });
		}
		return { action: 'deletePreset', success: true };
	},

	setDefault: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const presetId = form.get('presetId');
		if (typeof presetId !== 'string') {
			return fail(400, { action: 'setDefault', message: '入力が不正です' });
		}
		try {
			await setDefaultPresetForUser(db, user.id, presetId);
		} catch (err) {
			return presetActionFail(err, 'setDefault', { presetId });
		}
		return { action: 'setDefault', success: true };
	}
};
