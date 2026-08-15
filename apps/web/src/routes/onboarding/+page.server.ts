import { fail, redirect } from '@sveltejs/kit';
import { formActionFail } from '$lib/server/action-errors';
import { requireAuthedDb } from '$lib/server/api';
import { markOnboardingSeen } from '$lib/server/onboarding';
import { savePushSubscription } from '$lib/server/push-subscriptions';
import type { Actions, PageServerLoad } from './$types';

// (app)/+layout.server.ts と同じ認証ガード。このページは (app) グループの外
// （ボトムナビの無い全画面レイアウトにするため、login と同じ階層）にあるため独自に持つ。
export const load: PageServerLoad = ({ locals, url, platform }) => {
	if (!locals.user) {
		const redirectTo = encodeURIComponent(url.pathname + url.search);
		redirect(303, `/login?redirectTo=${redirectTo}`);
	}
	return {
		vapidPublicKey: platform?.env.VAPID_PUBLIC_KEY ?? null
	};
};

export const actions: Actions = {
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
			return formActionFail(err, 'subscribePush', {});
		}
		return { action: 'subscribePush', success: true };
	},

	// 「スキップ」「完了」共通。以後 (app)/+page.server.ts から自動でここへ
	// 戻されなくなる（#24）。
	finish: async (event) => {
		const { user, db } = requireAuthedDb(event);
		await markOnboardingSeen(db, user.id);
		redirect(303, '/');
	}
};
