import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';

// `better-auth generate` 専用の設定。D1 には接続しない（`drizzle({} as D1Database)` は
// 未使用のダミー）ため、Kysely の introspection が D1 の内部テーブル `_cf_METADATA` を
// 読もうとして失敗する問題を回避できる。実行時の設定は apps/web/src/lib/server/auth.ts。
//
// `socialProviders`/`plugins` は生成されるテーブル・カラムに影響しない（Google OAuth は
// 追加フィールドを持たないため）ので、ここには含めない。
export const auth = betterAuth({
	database: drizzleAdapter(drizzle({} as D1Database), { provider: 'sqlite' })
});
