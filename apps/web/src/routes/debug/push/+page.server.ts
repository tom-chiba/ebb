import { dev } from '$app/environment';
import { error, fail } from '@sveltejs/kit';
import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
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

		let subscription: PushSubscription;
		try {
			subscription = JSON.parse(subscriptionRaw);
		} catch {
			return fail(400, { error: 'subscription の JSON 解析に失敗した' });
		}

		// 暗号処理（buildPushPayload）からレスポンス本文読み取り完了までを通しで計測する。
		// Workers 上の CPU 時間そのものではない（本番の Workers Logs で別途確認が必要）。
		const startedAt = Date.now();

		let payload: Awaited<ReturnType<typeof buildPushPayload>>;
		try {
			payload = await buildPushPayload(
				{ data: { title: 'Ebb', body: 'Web Push 検証 (#8)' } },
				subscription,
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

		const requestBody = new Uint8Array(payload.body);

		let response: Response;
		try {
			response = await fetch(subscription.endpoint, { ...payload, body: requestBody });
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
