import { dev } from '$app/environment';
import { error, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth';
import { createDb, eq, user } from '@ebb/db';
import { createAuth } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// サンドボックスでは Google OAuth の実ログインが通らないため、動作確認用に固定の
// メール/パスワードでログインさせる（#65）。パスワードはローカル D1 に永続化される
// （pnpm dev の再起動をまたぐ）ため、この値は変更しない運用にする。変更すると
// 「ユーザーは存在するがパスワード不一致」の状態になり、下の再作成処理が毎回走る。
const DEV_LOGIN_NAME = 'Dev Login';
const DEV_LOGIN_EMAIL = 'dev-login@ebb.local';
const DEV_LOGIN_PASSWORD = 'dev-login-password-do-not-change';

export const GET: RequestHandler = async (event) => {
	if (!dev) {
		error(404, 'Not Found');
	}
	if (!event.platform?.env.DB) {
		error(500, 'platform.env.DB is not available');
	}

	const auth = createAuth(event.platform.env, event.url.origin);
	const db = createDb(event.platform.env.DB);

	// signInEmail の失敗は「未登録」と「パスワード不一致」を区別しない（timing attack
	// 対策で意図的に同じエラーにしている）ため、存在判定はここで事前に行う。
	const existing = await db.query.user.findFirst({ where: eq(user.email, DEV_LOGIN_EMAIL) });

	if (!existing) {
		await auth.api.signUpEmail({
			body: { name: DEV_LOGIN_NAME, email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }
		});
	} else {
		try {
			await auth.api.signInEmail({
				body: { email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }
			});
		} catch (err) {
			// ユーザーの存在は上で確認済みのため、ここで signInEmail が失敗するのは
			// DEV_LOGIN_PASSWORD 変更によるパスワード不一致とみなせる。それ以外の失敗
			// （D1 未マイグレーション・レート制限等）まで再作成扱いにしないよう、
			// better-auth が返すエラーコードで絞り込む。
			if (!(err instanceof APIError) || err.body?.code !== 'INVALID_EMAIL_OR_PASSWORD') {
				throw err;
			}
			await db.delete(user).where(eq(user.email, DEV_LOGIN_EMAIL));
			await auth.api.signUpEmail({
				body: { name: DEV_LOGIN_NAME, email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD }
			});
		}
	}

	redirect(302, '/debug/auth');
};
