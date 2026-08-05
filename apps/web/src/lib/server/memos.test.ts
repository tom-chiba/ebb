import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, intervalPresets, user, type Db } from '@ebb/db';
import {
	archiveMemo,
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
		expect(memo.archivedAt).toBeNull();
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

	it('paginates with limit/offset', async () => {
		for (let i = 0; i < 3; i++) {
			await createMemo(db, ownerId, {
				title: `memo ${i}`,
				content: 'c',
				intervalPresetId: ownerPresetId
			});
		}
		const page1 = await listMemos(db, ownerId, { limit: 2, offset: 0 });
		const page2 = await listMemos(db, ownerId, { limit: 2, offset: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page2.items).toHaveLength(1);
		expect(page1.total).toBe(3);
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
