import { applyD1Migrations, env } from 'cloudflare:test';

// setup file はテストごとのストレージ分離の外側で実行され、複数回呼ばれ得るが、
// applyD1Migrations は未適用のマイグレーションだけを適用するため安全。
if (env.TEST_MIGRATIONS) {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
