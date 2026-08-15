import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, eq, userSettings, type Db } from '@ebb/db';
import { hasSeenOnboarding, markOnboardingSeen } from './onboarding';
import { createTestUser } from './test-helpers';

let db: Db;
let userId: string;

beforeEach(async () => {
	db = createDb(env.DB);
	userId = await createTestUser(db);
});

describe('hasSeenOnboarding', () => {
	it('returns false when the user has no user_settings row yet', async () => {
		expect(await hasSeenOnboarding(db, userId)).toBe(false);
	});

	it('returns false when the row exists but onboarding_seen_at is null', async () => {
		await db.insert(userSettings).values({ userId });
		expect(await hasSeenOnboarding(db, userId)).toBe(false);
	});

	it('returns true after markOnboardingSeen', async () => {
		await markOnboardingSeen(db, userId);
		expect(await hasSeenOnboarding(db, userId)).toBe(true);
	});
});

describe('markOnboardingSeen', () => {
	it('creates a user_settings row when none exists', async () => {
		await markOnboardingSeen(db, userId);

		const rows = await db
			.select({ onboardingSeenAt: userSettings.onboardingSeenAt })
			.from(userSettings)
			.where(eq(userSettings.userId, userId))
			.all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.onboardingSeenAt).toBeInstanceOf(Date);
	});

	it('does not clobber an existing defaultIntervalPresetId when marking seen', async () => {
		await db.insert(userSettings).values({ userId, defaultIntervalPresetId: null });

		await markOnboardingSeen(db, userId);

		const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).all();
		expect(rows[0]?.onboardingSeenAt).toBeInstanceOf(Date);
	});

	it('is idempotent when called twice', async () => {
		await markOnboardingSeen(db, userId);
		await markOnboardingSeen(db, userId);

		const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).all();
		expect(rows).toHaveLength(1);
	});
});
