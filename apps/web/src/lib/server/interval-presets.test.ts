import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, eq, intervalPresets, reviews, userSettings, type Db } from '@ebb/db';
import { NotFoundError, ValidationError } from './errors';
import {
	countReviewsAffectedByPresetChange,
	createCustomPreset,
	deleteCustomPreset,
	DEFAULT_INTERVAL_PRESET_ID,
	getDefaultPresetId,
	listPresetsForUser,
	setDefaultPresetForUser,
	updateCustomPresetIntervals
} from './interval-presets';
import { archiveMemo, createMemo } from './memos';
import { completeReview } from './reviews';
import { createTestUser } from './test-helpers';

let db: Db;
let ownerId: string;
let otherUserId: string;
let systemPresetId: string;
let ownerPresetId: string;
let otherUserPresetId: string;

beforeEach(async () => {
	db = createDb(env.DB);
	ownerId = await createTestUser(db);
	otherUserId = await createTestUser(db);

	const [systemPreset] = await db
		.insert(intervalPresets)
		.values({ userId: null, name: 'system preset', intervals: [1, 6, 24] })
		.returning();
	const [ownerPreset] = await db
		.insert(intervalPresets)
		.values({ userId: ownerId, name: 'owner preset', intervals: [1, 24, 72] })
		.returning();
	const [otherPreset] = await db
		.insert(intervalPresets)
		.values({ userId: otherUserId, name: 'other user preset', intervals: [1] })
		.returning();
	if (!systemPreset || !ownerPreset || !otherPreset) throw new Error('fixture setup failed');
	systemPresetId = systemPreset.id;
	ownerPresetId = ownerPreset.id;
	otherUserPresetId = otherPreset.id;
});

describe('listPresetsForUser', () => {
	it('returns system presets and the user own custom presets, but not other users custom presets', async () => {
		const presets = await listPresetsForUser(db, ownerId);
		const ids = presets.map((p) => p.id);
		expect(ids).toContain(systemPresetId);
		expect(ids).toContain(ownerPresetId);
		expect(ids).not.toContain(otherUserPresetId);
	});

	it('marks isSystem correctly', async () => {
		const presets = await listPresetsForUser(db, ownerId);
		expect(presets.find((p) => p.id === systemPresetId)?.isSystem).toBe(true);
		expect(presets.find((p) => p.id === ownerPresetId)?.isSystem).toBe(false);
	});

	it('marks inUse only when a memo (including archived) references the preset', async () => {
		const before = await listPresetsForUser(db, ownerId);
		expect(before.find((p) => p.id === ownerPresetId)?.inUse).toBe(false);

		const memo = await createMemo(db, ownerId, {
			title: 'm',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const afterCreate = await listPresetsForUser(db, ownerId);
		expect(afterCreate.find((p) => p.id === ownerPresetId)?.inUse).toBe(true);

		await archiveMemo(db, ownerId, memo.id);
		const afterArchive = await listPresetsForUser(db, ownerId);
		// アーカイブ済みでも FK は残っているため使用中のまま。
		expect(afterArchive.find((p) => p.id === ownerPresetId)?.inUse).toBe(true);
	});
});

describe('createCustomPreset', () => {
	it('creates a preset owned by the caller with parsed intervals', async () => {
		const preset = await createCustomPreset(db, ownerId, 'my preset', '1h, 6h, 1d');
		expect(preset.userId).toBe(ownerId);
		expect(preset.intervals).toEqual([1, 6, 24]);
	});

	it('rejects an empty name', async () => {
		await expect(createCustomPreset(db, ownerId, '   ', '1h')).rejects.toThrow(ValidationError);
	});

	it('rejects invalid intervals (validation delegated to packages/core)', async () => {
		await expect(createCustomPreset(db, ownerId, 'bad', '2h, 1h')).rejects.toThrow(ValidationError);
	});
});

describe('updateCustomPresetIntervals', () => {
	it('rejects editing a system preset', async () => {
		await expect(updateCustomPresetIntervals(db, ownerId, systemPresetId, '1h')).rejects.toThrow(
			ValidationError
		);
	});

	it('rejects editing another users custom preset without revealing it exists', async () => {
		await expect(updateCustomPresetIntervals(db, ownerId, otherUserPresetId, '1h')).rejects.toThrow(
			NotFoundError
		);
	});

	it('rejects a nonexistent presetId', async () => {
		await expect(updateCustomPresetIntervals(db, ownerId, 'does-not-exist', '1h')).rejects.toThrow(
			NotFoundError
		);
	});

	it('rejects invalid intervals without mutating the preset', async () => {
		await expect(updateCustomPresetIntervals(db, ownerId, ownerPresetId, '2h, 1h')).rejects.toThrow(
			ValidationError
		);
		const [preset] = await db
			.select()
			.from(intervalPresets)
			.where(eq(intervalPresets.id, ownerPresetId))
			.all();
		expect(preset?.intervals).toEqual([1, 24, 72]);
	});

	it('recalculates incomplete reviews for every non-archived memo using the preset', async () => {
		const memoA = await createMemo(db, ownerId, {
			title: 'a',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const memoB = await createMemo(db, ownerId, {
			title: 'b',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'2h, 5h'
		);
		// 2つのメモ、それぞれ元の3ステップ全てが未完了だったため合計6件。
		expect(updatedReviewsCount).toBe(6);

		for (const memo of [memoA, memoB]) {
			const rows = await db
				.select()
				.from(reviews)
				.where(eq(reviews.memoId, memo.id))
				.orderBy(reviews.step)
				.all();
			expect(rows).toHaveLength(2);
			expect(rows[0]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 2 * 60 * 60 * 1000);
			expect(rows[1]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 5 * 60 * 60 * 1000);
		}
	});

	it('excludes archived memos from both the preview count and the actual recalculation', async () => {
		const activeMemo = await createMemo(db, ownerId, {
			title: 'active',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const archivedMemo = await createMemo(db, ownerId, {
			title: 'archived',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, archivedMemo.id);

		const previewCount = await countReviewsAffectedByPresetChange(db, ownerPresetId);
		expect(previewCount).toBe(3); // active memo だけの3ステップ

		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'2h'
		);
		expect(updatedReviewsCount).toBe(3);

		const activeRows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, activeMemo.id))
			.all();
		expect(activeRows).toHaveLength(1);

		// アーカイブ済みメモの reviews（archiveMemo が未完了行を削除済み）は
		// このメモの reviews は archiveMemo により既に0件のはずで、再計算対象にもならない。
		const archivedRows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, archivedMemo.id))
			.all();
		expect(archivedRows).toHaveLength(0);
	});

	it('treats a memo as fully completed when the new intervals length is at or below the completed step count', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm', // ownerPreset の intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		// step0 を過去日時にして due にした上で完了させる（completeReview を経由し、
		// 「常に最小の未完了stepから」という不変条件込みで完了済み行を作る）。
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(Date.now() - 1000) })
			.where(eq(reviews.memoId, memo.id));
		const [due] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.limit(1)
			.all();
		if (!due) throw new Error('fixture setup failed');
		await completeReview(db, ownerId, due.id);

		// 新しいプリセットは1ステップのみ（既に完了済みの1ステップ以下）。
		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'1h'
		);
		expect(updatedReviewsCount).toBe(2); // 元の step1・step2 の2件が削除される

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, memo.id)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.completedAt).not.toBeNull();
	});
});

describe('deleteCustomPreset', () => {
	it('deletes an unused custom preset', async () => {
		await deleteCustomPreset(db, ownerId, ownerPresetId);
		const rows = await db
			.select()
			.from(intervalPresets)
			.where(eq(intervalPresets.id, ownerPresetId))
			.all();
		expect(rows).toHaveLength(0);
	});

	it('rejects deleting a preset that is in use, including by an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);

		await expect(deleteCustomPreset(db, ownerId, ownerPresetId)).rejects.toThrow(ValidationError);
	});

	it('rejects deleting a system preset', async () => {
		await expect(deleteCustomPreset(db, ownerId, systemPresetId)).rejects.toThrow(ValidationError);
	});

	it('rejects deleting another users custom preset without revealing it exists', async () => {
		await expect(deleteCustomPreset(db, ownerId, otherUserPresetId)).rejects.toThrow(NotFoundError);
	});

	it('clears (does not block) a user default that pointed at the deleted preset', async () => {
		await setDefaultPresetForUser(db, ownerId, ownerPresetId);
		await deleteCustomPreset(db, ownerId, ownerPresetId);

		// user_settings.default_interval_preset_id は onDelete: 'set null'。
		expect(await getDefaultPresetId(db, ownerId)).toBe(DEFAULT_INTERVAL_PRESET_ID);
		const [row] = await db
			.select()
			.from(userSettings)
			.where(eq(userSettings.userId, ownerId))
			.all();
		expect(row?.defaultIntervalPresetId).toBeNull();
	});
});

describe('setDefaultPresetForUser / getDefaultPresetId', () => {
	it('falls back to DEFAULT_INTERVAL_PRESET_ID when the user has never set one', async () => {
		expect(await getDefaultPresetId(db, ownerId)).toBe(DEFAULT_INTERVAL_PRESET_ID);
	});

	it('accepts a system preset', async () => {
		await setDefaultPresetForUser(db, ownerId, systemPresetId);
		expect(await getDefaultPresetId(db, ownerId)).toBe(systemPresetId);
	});

	it('accepts the user own custom preset and overwrites a previous choice', async () => {
		await setDefaultPresetForUser(db, ownerId, systemPresetId);
		await setDefaultPresetForUser(db, ownerId, ownerPresetId);
		expect(await getDefaultPresetId(db, ownerId)).toBe(ownerPresetId);
	});

	it('rejects another users custom preset', async () => {
		await expect(setDefaultPresetForUser(db, ownerId, otherUserPresetId)).rejects.toThrow(
			ValidationError
		);
	});
});
