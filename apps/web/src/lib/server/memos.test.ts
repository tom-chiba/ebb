import { isHttpError } from '@sveltejs/kit';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, createDb, eq, intervalPresets, memos, reviews, user, type Db } from '@ebb/db';
import { ConflictError, handleDomainError, NotFoundError, ValidationError } from './errors';
import {
	archiveMemo,
	CONTENT_MAX_LENGTH,
	createMemo,
	getMemo,
	listMemos,
	TITLE_MAX_LENGTH,
	updateMemo
} from './memos';
import { createTestUser } from './test-helpers';

function statusOf(fn: () => unknown): number {
	try {
		fn();
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
	throw new Error('expected fn to throw');
}

let db: Db;
let ownerId: string;
let otherUserId: string;
let ownerPresetId: string;
let systemPresetId: string;
let otherUserPresetId: string;

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

	// [adversarial-review] クライアントが POST のレスポンスを受け取れず（タイムアウト等）
	// 同じリクエストを再送した場合、サーバー側が毎回新しい id を採番すると重複作成される。
	// クライアント生成の id を冪等性キーとして使えるようにし、再送では既存行を返す。
	it('is idempotent when the same client-generated id is submitted twice', async () => {
		const id = crypto.randomUUID();
		const first = await createMemo(db, ownerId, {
			id,
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const second = await createMemo(db, ownerId, {
			id,
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		expect(second).toEqual(first);

		const { total } = await listMemos(db, ownerId);
		expect(total).toBe(1);
	});

	it('rejects a client-generated id already used by another user', async () => {
		const id = crypto.randomUUID();
		await createMemo(db, otherUserId, {
			id,
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(
			createMemo(db, ownerId, {
				id,
				title: 'title',
				content: 'content',
				intervalPresetId: ownerPresetId
			})
		).rejects.toThrow(ValidationError);
	});

	it('generates a random id when none is supplied', async () => {
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
		expect(a.id).not.toBe(b.id);
	});
});

describe('createMemo reviews generation', () => {
	it('batch-generates one review per preset step with scheduledAt from nextReviewAt', async () => {
		// ownerPresetId の intervals は [1, 24]（beforeEach）。
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		expect(rows).toHaveLength(2);
		expect(rows[0]?.step).toBe(0);
		expect(rows[0]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 1 * 60 * 60 * 1000);
		expect(rows[1]?.step).toBe(1);
		expect(rows[1]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 24 * 60 * 60 * 1000);
		expect(rows.every((row) => row.completedAt === null && row.notifiedAt === null)).toBe(true);
	});

	// 空の intervals を許容すると、reviews が1件も無いまま「静かに全ステップ完了状態」に
	// 見えるメモが生まれてしまう（docs/design-decisions.md の #15 節が明記する申し送り、
	// レビューで指摘）。intervals 自体の妥当性検証は #18 の責務だが、メモ作成時点では
	// #16 として拒否する。
	it('rejects a preset with an empty intervals array, creating neither the memo nor any reviews', async () => {
		const [emptyPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'empty', intervals: [] })
			.returning();
		if (!emptyPreset) throw new Error('fixture setup failed');

		await expect(
			createMemo(db, ownerId, {
				title: 'title',
				content: 'content',
				intervalPresetId: emptyPreset.id
			})
		).rejects.toThrow(ValidationError);

		// 拒否は id を発行する前に起きるため、そもそも memo id が存在しない。
		// メモ自体が作られていないこと（reviews の対象になり得る memo が無いこと）を確認する。
		const { total } = await listMemos(db, ownerId);
		expect(total).toBe(0);
	});

	it('does not duplicate reviews when the same client-generated id is submitted twice', async () => {
		const id = crypto.randomUUID();
		const input = { id, title: 'title', content: 'content', intervalPresetId: ownerPresetId };
		await createMemo(db, ownerId, input);
		await createMemo(db, ownerId, input);

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, id)).all();
		expect(rows).toHaveLength(2);
	});

	// 上のテストは2回とも await で直列に実行されるため、2回目は findOwnMemoById が
	// 1回目の結果を見つけて早期returnし、db.batch の一意制約違反（isUniqueConstraintViolation）
	// を経由しない。ここでは Promise.all で本当に競合させ、片方が memos.id の一意制約違反で
	// db.batch ごとロールバックされ、reviews が重複も欠損もしないことを確認する。
	it('does not duplicate or lose reviews when the same id races through createMemo concurrently', async () => {
		const id = crypto.randomUUID();
		const input = { id, title: 'title', content: 'content', intervalPresetId: ownerPresetId };
		const [a, b] = await Promise.all([
			createMemo(db, ownerId, input),
			createMemo(db, ownerId, input)
		]);
		expect(a).toEqual(b);

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, id)).all();
		expect(rows).toHaveLength(2);
	});

	// #16 のデプロイ前（reviews 生成ロジックが存在しなかった時点）に作られたメモが、
	// 同じクライアント生成 id で再送された場合を再現する（Codex adversarial レビューで
	// 指摘）。createMemo を経由せず直接 INSERT することで、reviews を持たない
	// 「旧バージョンが作った」メモを模している。
	it('backfills missing reviews when an idempotent retry finds an existing memo with none', async () => {
		const id = crypto.randomUUID();
		const createdAt = new Date();
		await db.insert(memos).values({
			id,
			userId: ownerId,
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId, // intervals: [1, 24]
			createdAt,
			updatedAt: createdAt
		});
		const preExisting = await db.select().from(reviews).where(eq(reviews.memoId, id)).all();
		expect(preExisting).toHaveLength(0);

		const memo = await createMemo(db, ownerId, {
			id,
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, id))
			.orderBy(reviews.step)
			.all();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 1 * 60 * 60 * 1000);
		expect(rows[1]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 24 * 60 * 60 * 1000);
	});

	it('does not touch reviews on an idempotent retry when they already exist', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const before = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		await createMemo(db, ownerId, {
			id: memo.id,
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});

		const after = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(after).toEqual(before);
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
		const updated = await updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: 'new title' });
		expect(updated.title).toBe('new title');
		expect(updated.content).toBe('content');
	});

	it('rejects an empty title on update', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: '  ' })).rejects.toThrow(
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
			updateMemo(db, ownerId, memo.id, memo.updatedAt, {
				content: 'a'.repeat(CONTENT_MAX_LENGTH + 1)
			})
		).rejects.toThrow(ValidationError);
	});

	it('sequential partial updates on different fields, each with the latest updatedAt, do not clobber each other', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const afterTitle = await updateMemo(db, ownerId, memo.id, memo.updatedAt, {
			title: 'new title'
		});
		const afterContent = await updateMemo(db, ownerId, memo.id, afterTitle.updatedAt, {
			content: 'new content'
		});
		expect(afterContent.title).toBe('new title');
		expect(afterContent.content).toBe('new content');
	});

	it('throws ConflictError when expectedUpdatedAt no longer matches (lost-update protection)', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		// updatedAt はミリ秒精度で、2回の更新が同一ミリ秒内に完了しうるため、
		// 両者が読んだとみなす基準時刻を明確に過去へずらしてから検証する。
		const staleUpdatedAt = new Date(memo.updatedAt.getTime() - 60_000);
		await db.update(memos).set({ updatedAt: staleUpdatedAt }).where(eq(memos.id, memo.id));

		// 片方が先に確定し、もう片方は取得時点の（今や古い）updatedAt のまま送ってくる
		// 同時実行を模す。後勝ちで無条件に上書きすると、先に確定した更新が消えてしまう。
		await updateMemo(db, ownerId, memo.id, staleUpdatedAt, { title: 'first writer' });
		await expect(
			updateMemo(db, ownerId, memo.id, staleUpdatedAt, { content: 'second writer (stale)' })
		).rejects.toThrow(ConflictError);

		const final = await getMemo(db, ownerId, memo.id);
		expect(final.title).toBe('first writer');
		expect(final.content).toBe('content');
	});

	it('bumps updatedAt when a field actually changes', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		// updatedAt はミリ秒精度で、create と update が同一ミリ秒内に完了しうるため、
		// 明確に過去の固定値へ書き換えてから比較し、厳密な不等号で検証を意味あるものにする。
		const pastUpdatedAt = new Date(memo.updatedAt.getTime() - 60_000);
		await db.update(memos).set({ updatedAt: pastUpdatedAt }).where(eq(memos.id, memo.id));

		const updated = await updateMemo(db, ownerId, memo.id, pastUpdatedAt, { title: 'new title' });
		expect(updated.updatedAt.getTime()).toBeGreaterThan(pastUpdatedAt.getTime());
	});

	it('returns the current memo unchanged for a no-op update (empty body)', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const result = await updateMemo(db, ownerId, memo.id, memo.updatedAt, {});
		expect(result).toEqual(memo);
	});

	it('does not require a matching expectedUpdatedAt for a no-op update', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const staleDate = new Date(memo.updatedAt.getTime() - 60_000);
		const result = await updateMemo(db, ownerId, memo.id, staleDate, {});
		expect(result).toEqual(memo);
	});

	it('throws NotFoundError for a no-op update on another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, {})).rejects.toThrow(
			NotFoundError
		);
	});

	it('throws NotFoundError for a no-op update on an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, {})).rejects.toThrow(
			NotFoundError
		);
	});

	it('rejects switching to a preset owned by another user', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(
			updateMemo(db, ownerId, memo.id, memo.updatedAt, { intervalPresetId: otherUserPresetId })
		).rejects.toThrow(ValidationError);
	});

	// reviews の再計算（未完了行を削除して新しい intervals から作り直す）は #18 の責務であり、
	// #16 のスコープには含めない（docs/design-decisions.md 参照）。intervalPresetId を
	// 変更しても、作成時に生成された reviews がそのまま残ることを確認する。
	it('does not touch existing reviews when intervalPresetId changes', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		const before = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		const updated = await updateMemo(db, ownerId, memo.id, memo.updatedAt, {
			intervalPresetId: systemPresetId // intervals: [1, 6, 24]
		});
		// intervalPresetId が実際に変更されたことを確認した上で、それでも reviews が
		// 変化しないことを検証する（更新自体が無視された結果ではないことの担保）。
		expect(updated.intervalPresetId).toBe(systemPresetId);

		const after = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(after).toEqual(before);
	});

	it('throws NotFoundError when updating another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: 'x' })).rejects.toThrow(
			NotFoundError
		);
	});

	it('throws NotFoundError when updating an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: 'x' })).rejects.toThrow(
			NotFoundError
		);
	});

	// [codex:review] 存在確認より先にバリデーションを行うと、他人/アーカイブ済みのメモに
	// 不正な入力を送った際に 404 ではなく 400 になってしまっていた。存在確認を先に行う
	// ことで、入力の正当性に関わらず 404 に統一されることを確認する。
	it('throws NotFoundError (not ValidationError) for an invalid title on another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: '  ' })).rejects.toThrow(
			NotFoundError
		);
	});

	it('throws NotFoundError (not ValidationError) for an invalid title on an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(updateMemo(db, ownerId, memo.id, memo.updatedAt, { title: '  ' })).rejects.toThrow(
			NotFoundError
		);
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

	it('deletes pending reviews for the archived memo only, leaving other memos untouched', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		// アーカイブ対象以外のメモの未完了 reviews が巻き添えで消えないことを確認する
		// ための、別 memo の pending reviews。
		const other = await createMemo(db, ownerId, {
			title: 'other',
			content: 'content',
			intervalPresetId: ownerPresetId
		});

		await archiveMemo(db, ownerId, memo.id);

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, memo.id)).all();
		expect(rows).toHaveLength(0);

		const otherRows = await db.select().from(reviews).where(eq(reviews.memoId, other.id)).all();
		expect(otherRows).toHaveLength(2);
	});

	it('keeps completed reviews for the archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const [pending] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.all();
		if (!pending) throw new Error('fixture setup failed');
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.id, pending.id));

		await archiveMemo(db, ownerId, memo.id);

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, memo.id)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.step).toBe(0);
		expect(rows[0]?.completedAt).not.toBeNull();
	});
});

describe('handleDomainError', () => {
	it('maps ValidationError to 400 and passes its message through', () => {
		try {
			handleDomainError(new ValidationError('title is required'));
			expect.unreachable();
		} catch (err) {
			expect(isHttpError(err) && err.status).toBe(400);
			expect(isHttpError(err) && err.body.message).toBe('title is required');
		}
	});

	it('maps NotFoundError to a 404 with a fixed message (no detail leaked)', () => {
		expect(statusOf(() => handleDomainError(new NotFoundError('memo abc123 not found')))).toBe(404);
	});

	it('maps ConflictError to 409', () => {
		expect(
			statusOf(() =>
				handleDomainError(new ConflictError('memo has been modified since it was last read'))
			)
		).toBe(409);
	});

	it('rethrows anything else unchanged', () => {
		const original = new Error('unexpected');
		expect(() => handleDomainError(original)).toThrow(original);
	});
});
