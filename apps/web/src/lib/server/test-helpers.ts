import { user, type Db } from '@ebb/db';

// memos.test.ts / reviews.test.ts で共通のフィクスチャ。
export async function createTestUser(db: Db) {
	const id = crypto.randomUUID();
	await db.insert(user).values({ id, name: 'Test User', email: `${id}@example.com` });
	return id;
}
