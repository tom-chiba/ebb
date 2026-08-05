import type { Handle } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { isAuthPath } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { createAuth } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	if (building) {
		return resolve(event);
	}
	if (!event.platform?.env.DB) {
		error(500, 'platform.env.DB is not available');
	}
	if (!event.platform.env.BETTER_AUTH_SECRET) {
		// better-auth 自身の既知シークレットへのフォールバックは `NODE_ENV === 'production'`
		// でのみ throw する。Workers には `NODE_ENV` を自動で立てる仕組みが無いため、
		// そのガードに頼らずここで明示的に落とす（session cookie が公開鍵で署名される事故を防ぐ）。
		error(500, 'BETTER_AUTH_SECRET is not set');
	}

	const auth = createAuth(event.platform.env, event.url.origin);

	// `/api/auth/*` は auth.handler に直接ディスパッチする（svelteKitHandler と同じ判定を
	// 使う）。この分岐の手前で毎回 getSession を呼ぶと、結果を誰も読まないまま D1 に
	// 無駄な読み取りを発生させる。
	if (isAuthPath(event.url.toString(), auth.options)) {
		return auth.handler(event.request);
	}

	try {
		const session = await auth.api.getSession({ headers: event.request.headers });
		event.locals.user = session?.user ?? null;
		event.locals.session = session?.session ?? null;
	} catch (err) {
		// セッション行の競合削除や D1 の一時的な失敗で getSession が例外を投げても、
		// 認証と無関係な通常ページの閲覧まで 500 にしない。ただし診断のため記録は残す
		// （マイグレーション未適用など、本来気付くべき失敗を「未ログイン」に埋没させない）。
		console.error('getSession failed', err);
		event.locals.user = null;
		event.locals.session = null;
	}

	return resolve(event);
};
