import { fail } from '@sveltejs/kit';
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
import {
	deletePushSubscription,
	ownsPushSubscription,
	savePushSubscription
} from '$lib/server/push-subscriptions';
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
		maxIntervalCount: MAX_INTERVAL_COUNT,
		presetNameMaxLength: PRESET_NAME_MAX_LENGTH,
		// VAPID_PUBLIC_KEY 未設定を500にしてページ全体を落とすと、この設定画面に
		// 同居しているプリセット管理（#18）まで通知機能の設定漏れに巻き込まれる。
		// null を返し、通知セクション側だけを利用不可として表示する（設計レビューで指摘）。
		vapidPublicKey: event.platform?.env.VAPID_PUBLIC_KEY ?? null
	};
};

// ValidationError/NotFoundError/ConflictError をフォームアクションの fail() へ変換する。
// handleDomainError（$lib/server/errors）は SvelteKit の error() で投げる前提
// （load・+server.ts 向け）のため、フォームアクションではここで別途変換する。
// プリセット系・push 系の両方から使う共通ヘルパーのため、NotFoundError のメッセージは
// 呼び出し側が対象ドメインに応じて渡す（#19 でプリセット専用の固定文言だったものを
// 汎用化した。設計レビューで指摘）。
// action・extra をジェネリクスで受けることで、fail() の返り値がリテラル型
// （action）と実際のプロパティ（extra の各キー）を保持する。string/Record<string,
// unknown> に広げると、+page.svelte 側の `'name' in form` 等の判別が `unknown` に
// しか narrowing できなくなり、型ガードが実質的に機能しなくなる（設計レビューで指摘）。
function formActionFail<A extends string, E extends Record<string, unknown>>(
	err: unknown,
	action: A,
	extra: E,
	notFoundMessage = '見つかりません'
) {
	if (err instanceof ValidationError) {
		return fail(400, { action, message: err.message, ...extra });
	}
	if (err instanceof NotFoundError) {
		return fail(404, { action, message: notFoundMessage, ...extra });
	}
	if (err instanceof ConflictError) {
		return fail(409, { action, message: err.message, ...extra });
	}
	throw err;
}

// プリセット系アクション専用の薄いラッパー。NotFoundError のメッセージが
// 全プリセットアクションで同じ固定文言のため、呼び出し箇所ごとの重複を避ける。
function presetActionFail<A extends string, E extends Record<string, unknown>>(
	err: unknown,
	action: A,
	extra: E
) {
	return formActionFail(err, action, extra, 'プリセットが見つかりません');
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
			// savePushSubscription は ValidationError しか投げないため、この
			// NotFoundError 分岐には到達しない。到達しない以上メッセージの内容は
			// 意味を持たないため、formActionFail の既定値をそのまま使う。
			return formActionFail(err, 'subscribePush', {});
		}
		return { action: 'subscribePush', success: true };
	},

	checkPushSubscription: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const endpoint = form.get('endpoint');
		if (typeof endpoint !== 'string' || endpoint.length === 0) {
			return fail(400, { action: 'checkPushSubscription', message: '入力が不正です' });
		}
		return {
			action: 'checkPushSubscription',
			subscribed: await ownsPushSubscription(db, user.id, endpoint)
		};
	},

	// 冪等操作として扱う理由は $lib/server/push-subscriptions.ts の
	// deletePushSubscription のコメントを参照。
	unsubscribePush: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const endpoint = form.get('endpoint');
		if (typeof endpoint !== 'string') {
			return fail(400, { action: 'unsubscribePush', message: '入力が不正です' });
		}
		await deletePushSubscription(db, user.id, endpoint);
		return { action: 'unsubscribePush', success: true };
	}
};
