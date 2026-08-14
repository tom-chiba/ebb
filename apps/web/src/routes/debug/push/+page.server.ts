import { dev } from '$app/environment';
import { error, fail } from '@sveltejs/kit';
import { buildPushRequest, type PushSubscriptionRecord } from '@ebb/push';
import type { Actions, PageServerLoad } from './$types';

// 本番の VAPID 秘密鍵で任意の endpoint に fetch できてしまうため、開発環境限定にする
export const load: PageServerLoad = ({ platform }) => {
	if (!dev) {
		error(404, 'Not Found');
	}
	if (!platform?.env.VAPID_PUBLIC_KEY) {
		error(500, 'VAPID_PUBLIC_KEY が未設定');
	}
	return { vapidPublicKey: platform.env.VAPID_PUBLIC_KEY };
};

export const actions: Actions = {
	send: async ({ request, platform }) => {
		if (!dev) {
			error(404, 'Not Found');
		}
		if (!platform?.env.VAPID_PRIVATE_KEY) {
			return fail(500, { error: 'VAPID_PRIVATE_KEY が未設定' });
		}

		const form = await request.formData();
		const subscriptionRaw = form.get('subscription');
		if (typeof subscriptionRaw !== 'string' || subscriptionRaw.length === 0) {
			return fail(400, { error: 'subscription が空' });
		}

		// ブラウザの PushSubscription.toJSON() が返す形（endpoint / keys.p256dh / keys.auth）
		// を @ebb/push が要求するフラットな PushSubscriptionRecord に変換する。
		let subscriptionJson: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
		try {
			subscriptionJson = JSON.parse(subscriptionRaw);
		} catch {
			return fail(400, { error: 'subscription の JSON 解析に失敗した' });
		}
		if (
			typeof subscriptionJson.endpoint !== 'string' ||
			typeof subscriptionJson.keys?.p256dh !== 'string' ||
			typeof subscriptionJson.keys?.auth !== 'string'
		) {
			return fail(400, {
				error: 'subscription の形式が不正（endpoint / keys.p256dh / keys.auth が必要）'
			});
		}
		const subscription: PushSubscriptionRecord = {
			endpoint: subscriptionJson.endpoint,
			p256dh: subscriptionJson.keys.p256dh,
			auth: subscriptionJson.keys.auth
		};

		// 暗号処理（buildPushRequest）からレスポンス本文読み取り完了までを通しで計測する。
		// Workers 上の CPU 時間そのものではない（本番の Workers Logs で別途確認が必要）。
		const startedAt = Date.now();

		let pushRequest: Awaited<ReturnType<typeof buildPushRequest>>;
		try {
			pushRequest = await buildPushRequest(
				subscription,
				{ memoId: 'debug', title: 'Ebb', url: '/memos/debug' },
				{
					subject: platform.env.VAPID_SUBJECT,
					publicKey: platform.env.VAPID_PUBLIC_KEY,
					privateKey: platform.env.VAPID_PRIVATE_KEY
				}
			);
		} catch (err) {
			return fail(400, {
				error: `subscription または VAPID 鍵設定が不正: ${err instanceof Error ? err.message : String(err)}`
			});
		}

		let response: Response;
		try {
			response = await fetch(pushRequest.url, pushRequest.init);
		} catch (err) {
			return fail(502, {
				error: `push サービスへの fetch に失敗した: ${err instanceof Error ? err.message : String(err)}`
			});
		}

		let responseBody: string;
		try {
			responseBody = await response.text();
		} catch (err) {
			return fail(502, {
				error: `push サービスのレスポンス読み取りに失敗した: ${err instanceof Error ? err.message : String(err)}`
			});
		}
		const wallClockMs = Date.now() - startedAt;

		return { sendStatus: response.status, body: responseBody, wallClockMs };
	}
};
