import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, eq, pushSubscriptions, type Db } from '@ebb/db';
import { ValidationError } from './errors';
import {
	deletePushSubscription,
	ownsPushSubscription,
	savePushSubscription
} from './push-subscriptions';
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

		await deletePushSubscription(db, userId, 'https://push.example/a');

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/a'))
			.all();
		expect(rows).toHaveLength(0);
	});

	it('does not delete another user own subscription, and does not throw', async () => {
		await savePushSubscription(db, otherUserId, 'https://push.example/a', 'p', 'a');

		await expect(
			deletePushSubscription(db, userId, 'https://push.example/a')
		).resolves.toBeUndefined();

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/a'))
			.all();
		expect(rows).toHaveLength(1);
	});

	it('does not throw for a non-existent endpoint (already in the desired state)', async () => {
		await expect(
			deletePushSubscription(db, userId, 'https://push.example/missing')
		).resolves.toBeUndefined();
	});

	// 所有権付け替え後にこれを例外扱いすると無効化がデッドロックする理由は
	// deletePushSubscription のコメントを参照。
	it('does not throw when the endpoint has been reassigned to another user', async () => {
		await savePushSubscription(db, userId, 'https://push.example/shared', 'p1', 'a1');
		await savePushSubscription(db, otherUserId, 'https://push.example/shared', 'p2', 'a2');

		await expect(
			deletePushSubscription(db, userId, 'https://push.example/shared')
		).resolves.toBeUndefined();

		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, 'https://push.example/shared'))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ userId: otherUserId });
	});
});

describe('ownsPushSubscription', () => {
	it('returns true only when the endpoint belongs to the user', async () => {
		await savePushSubscription(db, userId, 'https://push.example/a', 'p', 'a');

		await expect(ownsPushSubscription(db, userId, 'https://push.example/a')).resolves.toBe(true);
		await expect(ownsPushSubscription(db, otherUserId, 'https://push.example/a')).resolves.toBe(
			false
		);
	});

	it('returns false for a missing or empty endpoint', async () => {
		await expect(ownsPushSubscription(db, userId, 'https://push.example/missing')).resolves.toBe(
			false
		);
		await expect(ownsPushSubscription(db, userId, '')).resolves.toBe(false);
	});
});
