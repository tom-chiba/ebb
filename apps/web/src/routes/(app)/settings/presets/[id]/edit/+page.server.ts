import { MAX_INTERVAL_COUNT } from '@ebb/core';
import { fail, redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { presetActionFail } from '$lib/server/action-errors';
import { handleDomainError } from '$lib/server/errors';
import {
	deleteCustomPreset,
	getOwnedCustomPreset,
	listMemosUsingPreset,
	previewPresetIntervalsUpdate,
	updateCustomPresetIntervals
} from '$lib/server/interval-presets';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const preset = await getOwnedCustomPreset(db, user.id, event.params.id);
		const usedMemos = await listMemosUsingPreset(db, preset.id);
		return {
			preset: { id: preset.id, name: preset.name, intervals: preset.intervals },
			usedMemos,
			maxIntervalCount: MAX_INTERVAL_COUNT
		};
	} catch (err) {
		handleDomainError(err);
	}
};

export const actions: Actions = {
	// 確認なし（confirmed !== 'true'）の送信では、実際の更新は行わず影響件数・差分の
	// プレビューだけを返す。ユーザーがそれを見て同じフォームを confirmed=true で
	// 再送信した場合にのみ実際に更新する（issue 本文の「変更の影響範囲を明示する」
	// への対応）。
	update: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const intervals = form.get('intervals');
		const confirmed = form.get('confirmed') === 'true';
		if (typeof intervals !== 'string') {
			return fail(400, { action: 'update', message: '入力が不正です' });
		}

		if (!confirmed) {
			try {
				const { previewCount, diff } = await previewPresetIntervalsUpdate(
					db,
					user.id,
					event.params.id,
					intervals
				);
				return { action: 'update', intervals, previewCount, diff };
			} catch (err) {
				return presetActionFail(err, 'update', { intervals });
			}
		}

		try {
			const { updatedReviewsCount } = await updateCustomPresetIntervals(
				db,
				user.id,
				event.params.id,
				intervals
			);
			// リダイレクトすると「n件の予定を更新しました」を伝える手段がなくなる
			// （/settings には反映後の intervals しか出ない）ため、このページに
			// 留まって結果を表示する。
			return { action: 'update', success: true, updatedReviewsCount };
		} catch (err) {
			return presetActionFail(err, 'update', { intervals });
		}
	},

	delete: async (event) => {
		const { user, db } = requireAuthedDb(event);
		try {
			await deleteCustomPreset(db, user.id, event.params.id);
		} catch (err) {
			return presetActionFail(err, 'delete', {});
		}
		redirect(303, '/settings');
	}
};
