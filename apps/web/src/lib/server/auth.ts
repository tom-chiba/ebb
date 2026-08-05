import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { createDb } from '@ebb/db';

// D1 バインディングはリクエストごとにしか手に入らない（Workers はモジュールスコープで
// bindings を持てない）ため、モジュールレベルの単一 `auth` インスタンスは作れない。
// `baseURL` をリクエストの origin から導出することで、local（vite dev / wrangler dev）と
// production の両方で Google OAuth の redirect_uri が実際のアクセス元と一致する。
export function createAuth(env: Env, origin: string) {
	const db = createDb(env.DB);
	return betterAuth({
		baseURL: origin,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, { provider: 'sqlite' }),
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET
			}
		},
		// 既定は `enabled: true ?? isProduction`（NODE_ENV === 'production' 判定）だが、
		// Workers は NODE_ENV を自動で立てないため明示的に有効化する。既定の in-memory storage
		// は Workers の各 isolate ごとに独立しカウントが共有されないため、D1 に永続化する
		// `storage: 'database'` を使う（`rateLimit` テーブルは auth-cli-config.ts と揃えて生成）。
		rateLimit: {
			enabled: true,
			storage: 'database',
			window: 60,
			max: 100,
			customRules: {
				// verification テーブルへの insert を伴うため、既定より厳しく絞る
				'/sign-in/social': { window: 60, max: 10 }
			}
		},
		// hooks.server.ts が `auth.api.getSession` を直接呼ぶ（`auth.handler` 経由ではない）
		// ため、そこで発生する Set-Cookie（セッションの延長・失効時の削除）は sveltekitCookies
		// を挟まない限り捨てられる。最後の plugin として登録する必要がある（公式ドキュメント）。
		plugins: [sveltekitCookies(getRequestEvent)]
	});
}

export type Auth = ReturnType<typeof createAuth>;
