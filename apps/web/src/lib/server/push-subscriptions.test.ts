import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, eq, pushSubscriptions, type Db } from '@ebb/db';
import { ValidationError } from './errors';
import { deletePushSubscription, savePushSubscription } from './push-subscriptions';
import { createTestUser } from './test-helpers';

let db: Db;
let userId: string;
let otherUserId: string;

beforeEach(async () => {
	db = createDb(env.DB);
	userId = await createTestUser(db);
	otherUserId = await createTestUser(db);
});

describe('savePushSubscription', () => {
	it('creates a new row for a new endpoint', async () => {
		await savePushSubscription(db, userId, 'https://push.example/a', 'p256dh-a', 'auth-a');

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/a'))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId,
			endpoint: 'https://push.example/a',
			p256dh: 'p256dh-a',
			auth: 'auth-a'
		});
	});

	it('allows the same user to hold multiple subscriptions (multiple devices)', async () => {
		await savePushSubscription(db, userId, 'https://push.example/device1', 'p1', 'a1');
		await savePushSubscription(db, userId, 'https://push.example/device2', 'p2', 'a2');

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.userId, userId))
			.all();
		expect(rows).toHaveLength(2);
	});

	it('re-subscribing the same endpoint updates keys and reassigns ownership', async () => {
		await savePushSubscription(db, otherUserId, 'https://push.example/shared', 'old-p', 'old-a');

		await savePushSubscription(db, userId, 'https://push.example/shared', 'new-p', 'new-a');

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/shared'))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId, p256dh: 'new-p', auth: 'new-a' });
	});

	it('rejects empty fields', async () => {
		await expect(savePushSubscription(db, userId, '', 'p', 'a')).rejects.toThrow(ValidationError);
		await expect(
			savePushSubscription(db, userId, 'https://push.example/x', '', 'a')
		).rejects.toThrow(ValidationError);
		await expect(
			savePushSubscription(db, userId, 'https://push.example/x', 'p', '')
		).rejects.toThrow(ValidationError);
	});
});

describe('deletePushSubscription', () => {
	it('deletes a subscription owned by the user', async () => {
		await savePushSubscription(db, userId, 'https://push.example/a', 'p', 'a');

		const result = await deletePushSubscription(db, userId, 'https://push.example/a');

		expect(result.deletedCount).toBe(1);
		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/a'))
			.all();
		expect(rows).toHaveLength(0);
	});

	it('does not delete another user own subscription', async () => {
		await savePushSubscription(db, otherUserId, 'https://push.example/a', 'p', 'a');

		const result = await deletePushSubscription(db, userId, 'https://push.example/a');

		expect(result.deletedCount).toBe(0);
		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/a'))
			.all();
		expect(rows).toHaveLength(1);
	});

	it('reports zero deleted for a non-existent endpoint', async () => {
		const result = await deletePushSubscription(db, userId, 'https://push.example/missing');
		expect(result.deletedCount).toBe(0);
	});
});
