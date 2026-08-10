import { user, type Db } from '@ebb/db';

// apps/web/src/lib/server/test-helpers.ts と同じ最小フィクスチャ。
export async function createTestUser(db: Db) {
	const id = crypto.randomUUID();
	await db.insert(user).values({ id, name: 'Test User', email: `${id}@example.com` });
	return id;
}
