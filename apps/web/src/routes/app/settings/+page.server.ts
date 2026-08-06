import { error, fail } from '@sveltejs/kit';
import { formatIntervals, MAX_INTERVAL_COUNT } from '@ebb/core';
import { requireAuthedDb } from '$lib/server/api';
import { ConflictError, NotFoundError, ValidationError } from '$lib/server/errors';
import {
	createCustomPreset,
	deleteCustomPreset,
	getDefaultPresetId,
	listPresetsForUser,
	PRESET_NAME_MAX_LENGTH,
	previewPresetIntervalsUpdate,
	setDefaultPresetForUser,
	updateCustomPresetIntervals
} from '$lib/server/interval-presets';
import { deletePushSubscription, savePushSubscription } from '$lib/server/push-subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	if (!event.platform?.env.VAPID_PUBLIC_KEY) {
		error(500, 'VAPID_PUBLIC_KEY が未設定');
	}
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
		maxIntervalCount: MAX_INTERVAL_COUNT,
		presetNameMaxLength: PRESET_NAME_MAX_LENGTH,
		vapidPublicKey: event.platform.env.VAPID_PUBLIC_KEY
	};
};

// ValidationError/NotFoundError/ConflictError をフォームアクションの fail() へ変換する。
// handleDomainError（$lib/server/errors）は SvelteKit の error() で投げる前提
// （load・+server.ts 向け）のため、フォームアクションではここで別途変換する。
// action・extra をジェネリクスで受けることで、fail() の返り値がリテラル型
// （action）と実際のプロパティ（extra の各キー）を保持する。string/Record<string,
// unknown> に広げると、+page.svelte 側の `'name' in form` 等の判別が `unknown` に
// しか narrowing できなくなり、型ガードが実質的に機能しなくなる（設計レビューで指摘）。
function presetActionFail<A extends string, E extends Record<string, unknown>>(
	err: unknown,
	action: A,
	extra: E
) {
	if (err instanceof ValidationError) {
		return fail(400, { action, message: err.message, ...extra });
	}
	if (err instanceof NotFoundError) {
		return fail(404, { action, message: 'プリセットが見つかりません', ...extra });
	}
	if (err instanceof ConflictError) {
		return fail(409, { action, message: err.message, ...extra });
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
				const { previewCount } = await previewPresetIntervalsUpdate(
					db,
					user.id,
					presetId,
					intervals
				);
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
	},

	subscribePush: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const endpoint = form.get('endpoint');
		const p256dh = form.get('p256dh');
		const auth = form.get('auth');
		if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
			return fail(400, { action: 'subscribePush', message: '入力が不正です' });
		}
		try {
			await savePushSubscription(db, user.id, endpoint, p256dh, auth);
		} catch (err) {
			return presetActionFail(err, 'subscribePush', {});
		}
		return { action: 'subscribePush', success: true };
	},

	unsubscribePush: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const endpoint = form.get('endpoint');
		if (typeof endpoint !== 'string') {
			return fail(400, { action: 'unsubscribePush', message: '入力が不正です' });
		}
		const { deletedCount } = await deletePushSubscription(db, user.id, endpoint);
		if (deletedCount === 0) {
			return fail(404, { action: 'unsubscribePush', message: '購読が見つかりません' });
		}
		return { action: 'unsubscribePush', success: true };
	}
};
