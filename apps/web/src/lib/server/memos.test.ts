import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, eq, intervalPresets, memos, user, type Db } from '@ebb/db';
import {
	archiveMemo,
	CONTENT_MAX_LENGTH,
	createMemo,
	getMemo,
	listMemos,
	NotFoundError,
	TITLE_MAX_LENGTH,
	updateMemo,
	ValidationError
} from './memos';

let db: Db;
let ownerId: string;
let otherUserId: string;
let ownerPresetId: string;
let systemPresetId: string;
let otherUserPresetId: string;

async function createTestUser(db: Db) {
	const id = crypto.randomUUID();
	await db.insert(user).values({ id, name: 'Test User', email: `${id}@example.com` });
	return id;
}

beforeEach(async () => {
	db = createDb(env.DB);
	ownerId = await createTestUser(db);
	otherUserId = await createTestUser(db);

	const [ownerPreset] = await db
		.insert(intervalPresets)
		.values({ userId: ownerId, name: 'owner preset', intervals: [1, 24] })
		.returning();
	const [systemPreset] = await db
		.insert(intervalPresets)
		.values({ userId: null, name: 'system preset', intervals: [1, 6, 24] })
		.returning();
	const [otherPreset] = await db
		.insert(intervalPresets)
		.values({ userId: otherUserId, name: 'other user preset', intervals: [1] })
		.returning();

	if (!ownerPreset || !systemPreset || !otherPreset) throw new Error('fixture setup failed');
	ownerPresetId = ownerPreset.id;
	systemPresetId = systemPreset.id;
	otherUserPresetId = otherPreset.id;
});

describe('DB fixtures', () => {
	it('seeds a user visible in the same test', async () => {
		const rows = await db.select().from(user).all();
		expect(rows.some((row) => row.id === ownerId)).toBe(true);
	});

	it('applies the tenant-isolation triggers on memos', async () => {
		const rows = await env.DB.prepare(
			"select name from sqlite_master where type = 'trigger' and tbl_name = 'memos'"
		).all();
		expect(rows.results.map((row) => row.name).sort()).toEqual([
			'memos_interval_preset_owner_insert',
			'memos_interval_preset_owner_update'
		]);
	});
});

describe('createMemo', () => {
	it('creates a memo with a custom preset owned by the user', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		expect(memo.userId).toBe(ownerId);
		// archivedAt は「取得できる memo は常に非アーカイブ」で常に null にしかならないため
		// レスポンスから落としている。
		expect(memo).not.toHaveProperty('archivedAt');
	});

	it('creates a memo referencing a system preset', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: systemPresetId
		});
		expect(memo.intervalPresetId).toBe(systemPresetId);
	});

	it('rejects an empty title', async () => {
		await expect(
			createMemo(db, ownerId, { title: '  ', content: 'content', intervalPresetId: ownerPresetId })
		).rejects.toThrow(ValidationError);
	});

	it('rejects a title over the length limit', async () => {
		await expect(
			createMemo(db, ownerId, {
				title: 'a'.repeat(TITLE_MAX_LENGTH + 1),
				content: 'content',
				intervalPresetId: ownerPresetId
			})
		).rejects.toThrow(ValidationError);
	});

	it('rejects a preset owned by another user', async () => {
		await expect(
			createMemo(db, ownerId, {
				title: 'title',
				content: 'content',
				intervalPresetId: otherUserPresetId
			})
		).rejects.toThrow(ValidationError);
	});

	it('rejects a non-existent preset id', async () => {
		await expect(
			createMemo(db, ownerId, {
				title: 'title',
				content: 'content',
				intervalPresetId: crypto.randomUUID()
			})
		).rejects.toThrow(ValidationError);
	});

	it('rejects content over the length limit', async () => {
		await expect(
			createMemo(db, ownerId, {
				title: 'title',
				content: 'a'.repeat(CONTENT_MAX_LENGTH + 1),
				intervalPresetId: ownerPresetId
			})
		).rejects.toThrow(ValidationError);
	});

	it('accepts a title exactly at the length limit', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'a'.repeat(TITLE_MAX_LENGTH),
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		expect(memo.title).toHaveLength(TITLE_MAX_LENGTH);
	});

	it('accepts content exactly at the length limit', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'a'.repeat(CONTENT_MAX_LENGTH),
			intervalPresetId: ownerPresetId
		});
		expect(memo.content).toHaveLength(CONTENT_MAX_LENGTH);
	});
});

describe('listMemos / getMemo', () => {
	it('lists only the requesting user own, non-archived memos', async () => {
		const own = await createMemo(db, ownerId, {
			title: 'own',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, otherUserId, {
			title: 'other',
			content: 'c',
			intervalPresetId: otherUserPresetId
		});
		await archiveMemo(db, ownerId, own.id);
		const archived = await createMemo(db, ownerId, {
			title: 'archived later',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, archived.id);
		const visible = await createMemo(db, ownerId, {
			title: 'visible',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemos(db, ownerId);
		expect(result.items.map((m) => m.id)).toEqual([visible.id]);
		expect(result.total).toBe(1);
	});

	it('paginates with limit/offset without overlap or omission across pages', async () => {
		const created = [];
		for (let i = 0; i < 3; i++) {
			created.push(
				await createMemo(db, ownerId, {
					title: `memo ${i}`,
					content: 'c',
					intervalPresetId: ownerPresetId
				})
			);
		}
		const page1 = await listMemos(db, ownerId, { limit: 2, offset: 0 });
		const page2 = await listMemos(db, ownerId, { limit: 2, offset: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page2.items).toHaveLength(1);
		expect(page1.total).toBe(3);

		const seenIds = [...page1.items, ...page2.items].map((m) => m.id).sort();
		expect(seenIds).toEqual([...created.map((m) => m.id)].sort());
	});

	it('defaults to a limit of 20 when not specified', async () => {
		for (let i = 0; i < 25; i++) {
			await createMemo(db, ownerId, {
				title: `memo ${i}`,
				content: 'c',
				intervalPresetId: ownerPresetId
			});
		}
		const result = await listMemos(db, ownerId);
		expect(result.limit).toBe(20);
		expect(result.items).toHaveLength(20);
		expect(result.total).toBe(25);
	});

	it('clamps a limit above the maximum down to 100', async () => {
		const result = await listMemos(db, ownerId, { limit: 1000 });
		expect(result.limit).toBe(100);
	});

	it('clamps a non-positive limit up to 1', async () => {
		const zero = await listMemos(db, ownerId, { limit: 0 });
		const negative = await listMemos(db, ownerId, { limit: -5 });
		expect(zero.limit).toBe(1);
		expect(negative.limit).toBe(1);
	});

	it('clamps a negative offset up to 0', async () => {
		const result = await listMemos(db, ownerId, { offset: -10 });
		expect(result.offset).toBe(0);
	});

	it('returns an empty page when offset is past the total', async () => {
		await createMemo(db, ownerId, { title: 'only', content: 'c', intervalPresetId: ownerPresetId });
		const result = await listMemos(db, ownerId, { offset: 50 });
		expect(result.items).toEqual([]);
		expect(result.total).toBe(1);
	});

	it('breaks createdAt ties using id for a stable order', async () => {
		const a = await createMemo(db, ownerId, {
			title: 'a',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const b = await createMemo(db, ownerId, {
			title: 'b',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const tiedTimestamp = new Date();
		await db.update(memos).set({ createdAt: tiedTimestamp }).where(eq(memos.id, a.id));
		await db.update(memos).set({ createdAt: tiedTimestamp }).where(eq(memos.id, b.id));

		const result = await listMemos(db, ownerId);
		const orderedIds = result.items.map((m) => m.id);
		const expectedOrder = [a.id, b.id].sort().reverse();
		expect(orderedIds).toEqual(expectedOrder);
	});

	it('throws NotFoundError for another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'other',
			content: 'c',
			intervalPresetId: otherUserPresetId
		});
		await expect(getMemo(db, ownerId, memo.id)).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError for an unknown id', async () => {
		await expect(getMemo(db, ownerId, crypto.randomUUID())).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError for an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(getMemo(db, ownerId, memo.id)).rejects.toThrow(NotFoundError);
	});
});

describe('updateMemo', () => {
	it('updates title and content', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const updated = await updateMemo(db, ownerId, memo.id, { title: 'new title' });
		expect(updated.title).toBe('new title');
		expect(updated.content).toBe('content');
	});

	it('rejects an empty title on update', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, { title: '  ' })).rejects.toThrow(
			ValidationError
		);
	});

	it('rejects content over the length limit on update', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(
			updateMemo(db, ownerId, memo.id, { content: 'a'.repeat(CONTENT_MAX_LENGTH + 1) })
		).rejects.toThrow(ValidationError);
	});

	it('concurrent partial updates on different fields do not clobber each other', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await Promise.all([
			updateMemo(db, ownerId, memo.id, { title: 'new title' }),
			updateMemo(db, ownerId, memo.id, { content: 'new content' })
		]);
		const final = await getMemo(db, ownerId, memo.id);
		expect(final.title).toBe('new title');
		expect(final.content).toBe('new content');
	});

	it('bumps updatedAt when a field actually changes', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const updated = await updateMemo(db, ownerId, memo.id, { title: 'new title' });
		expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(memo.updatedAt.getTime());
	});

	it('returns the current memo unchanged for a no-op update (empty body)', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const result = await updateMemo(db, ownerId, memo.id, {});
		expect(result).toEqual(memo);
	});

	it('throws NotFoundError for a no-op update on another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, {})).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError for a no-op update on an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(updateMemo(db, ownerId, memo.id, {})).rejects.toThrow(NotFoundError);
	});

	it('rejects switching to a preset owned by another user', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(
			updateMemo(db, ownerId, memo.id, { intervalPresetId: otherUserPresetId })
		).rejects.toThrow(ValidationError);
	});

	it('throws NotFoundError when updating another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, { title: 'x' })).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError when updating an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(updateMemo(db, ownerId, memo.id, { title: 'x' })).rejects.toThrow(NotFoundError);
	});
});

describe('archiveMemo', () => {
	it('sets archivedAt', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const archived = await archiveMemo(db, ownerId, memo.id);
		expect(archived.archivedAt).not.toBeNull();
	});

	it('throws NotFoundError for another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(archiveMemo(db, ownerId, memo.id)).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError when archiving an already-archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(archiveMemo(db, ownerId, memo.id)).rejects.toThrow(NotFoundError);
	});
});
