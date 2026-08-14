import { fail } from '@sveltejs/kit';
import { formatIntervals } from '@ebb/core';
import { requireAuthedDb } from '$lib/server/api';
import { formActionFail, presetActionFail } from '$lib/server/action-errors';
import {
	getDefaultPresetId,
	listPresetsForUser,
	setDefaultPresetForUser
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
		// VAPID_PUBLIC_KEY 未設定を500にしてページ全体を落とすと、この設定画面に
		// 同居しているプリセット管理（#18）まで通知機能の設定漏れに巻き込まれる。
		// null を返し、通知セクション側だけを利用不可として表示する（設計レビューで指摘）。
		vapidPublicKey: event.platform?.env.VAPID_PUBLIC_KEY ?? null
	};
};

export const actions: Actions = {
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
