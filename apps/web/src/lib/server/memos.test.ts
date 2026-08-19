import { isHttpError } from '@sveltejs/kit';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	and,
	createDb,
	eq,
	intervalPresets,
	memos,
	reviews,
	reviewSchedules,
	user,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { ConflictError, handleDomainError, NotFoundError, ValidationError } from './errors';
import {
	archiveMemo,
	changeMemoPreset,
	CONTENT_MAX_LENGTH,
	createMemo,
	getMemo,
	listMemos,
	listMemosForBrowse,
	TITLE_MAX_LENGTH,
	updateMemo
} from './memos';
import { updateCustomPresetIntervals } from './interval-presets';
import { completeReview, getCurrentPendingReview } from './reviews';
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

describe('listMemosForBrowse', () => {
	it('returns all memos with preset name when q is not specified', async () => {
		await createMemo(db, ownerId, {
			title: 'Cloudflare D1 のトランザクション制約',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId);
		expect(result.total).toBe(1);
		expect(result.items[0]?.presetName).toBe('owner preset');
	});

	it('matches memos whose title contains the query as a substring', async () => {
		await createMemo(db, ownerId, {
			title: 'Cloudflare D1 のトランザクション制約',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, {
			title: 'Web Push の VAPID 鍵',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemosForBrowse(db, ownerId, { q: 'D1' });
		expect(result.items.map((m) => m.title)).toEqual(['Cloudflare D1 のトランザクション制約']);
		expect(result.total).toBe(1);
	});

	// #28 でタイトルのみの検索（#60）から本文も対象に拡張した。
	it('matches memos whose content (not title) contains the query', async () => {
		await createMemo(db, ownerId, {
			title: '無関係なタイトル',
			content: '本文には特定のキーワードを書く',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, {
			title: '別のメモ',
			content: '一致しない本文',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemosForBrowse(db, ownerId, { q: '特定のキーワード' });
		expect(result.items.map((m) => m.title)).toEqual(['無関係なタイトル']);
	});

	it('does not duplicate a memo whose title and content both match the query', async () => {
		await createMemo(db, ownerId, {
			title: 'メモ機能のメモ',
			content: 'メモについてのメモ',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemosForBrowse(db, ownerId, { q: 'メモ' });
		expect(result.items).toHaveLength(1);
		expect(result.total).toBe(1);
	});

	// 2文字の日本語クエリでも一致すること（LIKE はトークナイザに依存しないため、
	// FTS5/trigram + MATCH で起こり得る「3文字未満は常に0件」問題はそもそも
	// 発生しない。docs/design-decisions.md 参照）。
	it('matches with a 2-character Japanese query', async () => {
		await createMemo(db, ownerId, {
			title: 'タグ機能の実装メモ',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: 'タグ' });
		expect(result.items.map((m) => m.title)).toEqual(['タグ機能の実装メモ']);
	});

	it('matches with a 1-character query', async () => {
		await createMemo(db, ownerId, {
			title: '確認用タイトル',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, {
			title: '無関係なメモ',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: '確' });
		expect(result.items.map((m) => m.title)).toEqual(['確認用タイトル']);
	});

	it('returns no items when the query matches nothing', async () => {
		await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: 'no such title' });
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('treats a blank query the same as no query', async () => {
		await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: '   ' });
		expect(result.total).toBe(1);
	});

	it('trims surrounding whitespace from a real query before matching', async () => {
		await createMemo(db, ownerId, {
			title: 'Cloudflare D1 のトランザクション制約',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: '  D1  ' });
		expect(result.total).toBe(1);
	});

	it('orders multiple matches newest-first, breaking createdAt ties by id', async () => {
		const a = await createMemo(db, ownerId, {
			title: 'match a',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const b = await createMemo(db, ownerId, {
			title: 'match b',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const tiedTimestamp = new Date();
		await db.update(memos).set({ createdAt: tiedTimestamp }).where(eq(memos.id, a.id));
		await db.update(memos).set({ createdAt: tiedTimestamp }).where(eq(memos.id, b.id));

		const result = await listMemosForBrowse(db, ownerId, { q: 'match' });
		const expectedOrder = [a.id, b.id].sort().reverse();
		expect(result.items.map((m) => m.id)).toEqual(expectedOrder);
	});

	it('paginates filtered results, keeping total as the filtered count', async () => {
		const created = [];
		for (let i = 0; i < 3; i++) {
			created.push(
				await createMemo(db, ownerId, {
					title: `paged match ${i}`,
					content: 'c',
					intervalPresetId: ownerPresetId
				})
			);
		}
		// フィルタに一致しないメモも混ぜ、offset/limit がフィルタ後の結果に対して
		// 適用されていることを確認する（フィルタ前の行に対して適用されるリグレッションの検出）。
		await createMemo(db, ownerId, {
			title: 'unrelated',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const page1 = await listMemosForBrowse(db, ownerId, { q: 'paged match', limit: 2, offset: 0 });
		const page2 = await listMemosForBrowse(db, ownerId, { q: 'paged match', limit: 2, offset: 2 });
		expect(page1.total).toBe(3);
		expect(page2.total).toBe(3);
		expect(page1.items).toHaveLength(2);
		expect(page2.items).toHaveLength(1);

		const seenIds = [...page1.items, ...page2.items].map((m) => m.id).sort();
		expect(seenIds).toEqual([...created.map((m) => m.id)].sort());
	});

	it('excludes archived memos even when their title matches the query', async () => {
		const archived = await createMemo(db, ownerId, {
			title: 'archived match',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, archived.id);

		const result = await listMemosForBrowse(db, ownerId, { q: 'archived match' });
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	// 上のテストはタイトル一致経由でのアーカイブ除外しか確認しておらず、
	// memoSearchCondition の or(title LIKE, content LIKE) の括弧付けが崩れて
	// content 側の条件が and チェーンの外に漏れても検出できない。本文一致でも
	// 同じ不変条件が保たれることを別途確認する。
	it('excludes archived memos even when their content matches the query', async () => {
		const archived = await createMemo(db, ownerId, {
			title: 'title',
			content: 'archived content match',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, archived.id);

		const result = await listMemosForBrowse(db, ownerId, { q: 'archived content match' });
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	// LIKE の % / _ はワイルドカードだが、検索語としてそのまま入力された場合は
	// リテラルな1文字として扱われるべき（設計判断、apps/web/src/lib/server/memos.ts の
	// likePattern を参照）。
	it('treats literal % and _ in the query as literal characters, not wildcards', async () => {
		await createMemo(db, ownerId, {
			title: '50% off',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, {
			title: '50X off',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const percentMatch = await listMemosForBrowse(db, ownerId, { q: '50%' });
		expect(percentMatch.items.map((m) => m.title)).toEqual(['50% off']);

		const underscoreQuery = await listMemosForBrowse(db, ownerId, { q: '50_' });
		expect(underscoreQuery.items).toEqual([]);
	});

	// 上のテストはタイトル側の ESCAPE のみを確認しており、memoSearchCondition
	// は title と content で別々の LIKE ... ESCAPE '\\' 節を持つ（memos.ts 参照）ため、
	// 本文側でも同様にリテラル % が正しくエスケープされることを別途確認する。
	it('treats literal % as a literal character in the content column too', async () => {
		await createMemo(db, ownerId, {
			title: 'キャンペーン情報',
			content: '割引は50%です',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, {
			title: '別のメモ',
			content: '割引は50Xです',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemosForBrowse(db, ownerId, { q: '50%' });
		expect(result.items.map((m) => m.title)).toEqual(['キャンペーン情報']);
	});

	it('does not match another user memo, even with a matching title', async () => {
		await createMemo(db, otherUserId, {
			title: 'shared title',
			content: 'c',
			intervalPresetId: otherUserPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: 'shared' });
		expect(result.items).toEqual([]);
	});

	// タイトル一致だけでなく、本文一致経由でも他ユーザーのメモが漏れないことを
	// 確認する（上のテストと同じ理由。memoSearchCondition の or() の括弧付けが
	// 崩れた場合、content 側でのみ顕在化しうる）。
	it('does not match another user memo, even with matching content', async () => {
		await createMemo(db, otherUserId, {
			title: 'title',
			content: 'shared content',
			intervalPresetId: otherUserPresetId
		});
		const result = await listMemosForBrowse(db, ownerId, { q: 'shared content' });
		expect(result.items).toEqual([]);
	});

	it('reports the next scheduled time as the current (smallest incomplete step) pending review', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		const result = await listMemosForBrowse(db, ownerId);
		expect(result.items[0]?.nextScheduledAt?.getTime()).toBe(
			memo.createdAt.getTime() + 1 * 60 * 60 * 1000
		);
	});

	it('reports null next scheduled time once every review step is completed', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.memoId, memo.id));

		const result = await listMemosForBrowse(db, ownerId);
		expect(result.items[0]?.nextScheduledAt).toBeNull();
	});

	// 上の2テストはメモを1件しか作らないため、LEFT JOIN の結合条件を取り違えても
	// （例えば groupBy を落として他メモの行と混ざっても）検出できない。2件以上の
	// メモを同時に持たせ、各メモの nextScheduledAt が自分自身の reviews にのみ
	// 基づくことを確認する（レビューで指摘）。
	it('computes nextScheduledAt independently per memo when multiple memos exist', async () => {
		const completed = await createMemo(db, ownerId, {
			title: 'fully completed',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		await db
			.update(reviews)
			.set({ completedAt: new Date() })
			.where(eq(reviews.memoId, completed.id));
		const pending = await createMemo(db, ownerId, {
			title: 'still pending',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const result = await listMemosForBrowse(db, ownerId);
		const byId = new Map(result.items.map((m) => [m.id, m]));
		expect(byId.get(completed.id)?.nextScheduledAt).toBeNull();
		expect(byId.get(pending.id)?.nextScheduledAt?.getTime()).toBe(
			pending.createdAt.getTime() + 1 * 60 * 60 * 1000
		);
	});

	// #82 のデプロイより前に古い updateMemo でプリセットだけが変更され、reviews が
	// 作り直されていない既存メモを模す: step 0（未完了）の scheduledAt が、
	// 本来より後の step 1（同じく未完了）の scheduledAt より「遅い」。
	// min(scheduledAt) で選ぶ旧実装だと nextScheduledAt が step 1 の時刻になってしまう
	// （#83 が解消する不整合）。現在の定義（最小未完了 step）なら、常に
	// scheduledAt の大小に関係なく step 0 の scheduledAt を返す。
	it('does not let a later pending step with an earlier scheduledAt overtake an earlier step', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		const now = new Date();
		const step0ScheduledAt = new Date(now.getTime() + 10_000);
		const step1ScheduledAt = new Date(now.getTime() - 10_000);
		await db
			.update(reviews)
			.set({ scheduledAt: step0ScheduledAt })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)));
		await db
			.update(reviews)
			.set({ scheduledAt: step1ScheduledAt })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)));

		const result = await listMemosForBrowse(db, ownerId);
		expect(result.items[0]?.nextScheduledAt?.getTime()).toBe(step0ScheduledAt.getTime());
	});

	// メモ一覧（listMemosForBrowse）とメモ詳細（getCurrentPendingReview）が同じ
	// current pending review を指すことを直接突き合わせる（#83 の受入条件
	// 「メモ一覧と詳細で同じ次回 review が表示される」）。上と同じ「後続 step の
	// scheduledAt が前 step より早い」skewed なフィクスチャを使う（両 step とも
	// 未完了のまま）。未完了行が1件しかないフィクスチャでは min(scheduledAt) 方式
	// でも min(step) 方式でも同じ行を選んでしまい、両者の乖離を検出できない
	// （テスト網羅性レビューで指摘）。
	it('agrees with getCurrentPendingReview on which step is current', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		const now = new Date();
		const step0ScheduledAt = new Date(now.getTime() + 10_000);
		const step1ScheduledAt = new Date(now.getTime() - 10_000);
		await db
			.update(reviews)
			.set({ scheduledAt: step0ScheduledAt })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)));
		await db
			.update(reviews)
			.set({ scheduledAt: step1ScheduledAt })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)));

		const [browseResult, currentReview] = await Promise.all([
			listMemosForBrowse(db, ownerId),
			getCurrentPendingReview(db, memo.id)
		]);

		expect(currentReview?.step).toBe(0);
		expect(browseResult.items[0]?.nextScheduledAt?.getTime()).toBe(
			currentReview?.scheduledAt.getTime()
		);
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

	// Issue #85 の設計判断の裏付け: review_schedules.version を memos の列にせず
	// 専用テーブルへ分離した理由は、drizzle の buildUpdateSet が $onUpdate 持ちの列
	// （memos.updatedAt）を、その列を .set() に含めない UPDATE でも自動で SET 句に
	// 追加してしまう（実測確認済み）ため。version を memos の列にすると、
	// completeReview のたびに updatedAt が意図せず進み、他クライアントが読んでいた
	// updatedAt を使った title/content の更新が復習完了のたびに 409 になってしまう。
	// この非結合を回帰させないためのテスト。
	it('does not conflict a title-only update with an updatedAt read before an unrelated review completion', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title', // ownerPreset の intervals: [1, 24]
			content: 'content',
			intervalPresetId: ownerPresetId
		});
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

		// クライアントが memo.updatedAt を読んだ後、（このクライアントとは無関係に）
		// review を完了させる操作が挟まる。
		await completeReview(db, ownerId, due.id);

		// クライアントが読んでいた（完了前の）updatedAt を使って title だけを更新する。
		const updated = await updateMemo(db, ownerId, memo.id, memo.updatedAt, {
			title: 'new title'
		});
		expect(updated.title).toBe('new title');
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

	// intervalPresetId の変更は changeMemoPreset の責務に分離されている（#82）。
	// updateMemo は title/content だけを受け付け、reviews には一切触れないことを確認する。
	it('does not touch existing reviews when updateMemo changes title/content only', async () => {
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
			title: 'new title',
			content: 'new content'
		});
		expect(updated.intervalPresetId).toBe(ownerPresetId);

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

describe('changeMemoPreset', () => {
	it('rejects switching to a preset owned by another user', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(
			changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
				intervalPresetId: otherUserPresetId
			})
		).rejects.toThrow(ValidationError);
	});

	it('rejects switching to a preset with no intervals', async () => {
		const [emptyPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'empty', intervals: [] })
			.returning();
		if (!emptyPreset) throw new Error('fixture setup failed');
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await expect(
			changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, { intervalPresetId: emptyPreset.id })
		).rejects.toThrow(ValidationError);
	});

	// #82 の核心: プリセット変更で未完了 reviews が新しい intervals に基づいて
	// 再計算されること、完了済み reviews は保持されることを確認する。
	it('recalculates incomplete reviews based on the new preset and preserves completed reviews', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		// step 0 を完了済みにしておく（完了済み行は再計算の対象外であることの検証用）。
		const completedAt = new Date(memo.createdAt.getTime() + 1000);
		await db
			.update(reviews)
			.set({ completedAt })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)));

		const updated = await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			intervalPresetId: systemPresetId // intervals: [1, 6, 24]
		});
		expect(updated.intervalPresetId).toBe(systemPresetId);

		const after = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		// step 0 (完了済み) はそのまま残る。
		const step0 = after.find((r) => r.step === 0);
		expect(step0?.completedAt?.getTime()).toBe(completedAt.getTime());

		// 未完了だった step 1 は削除され、新しい intervals（システムプリセットの
		// intervals: [1, 6, 24]）に基づいて completedAt を起点に作り直される。
		// 大小関係だけでなく、実際に nextReviewAt が計算する値と厳密に一致すること
		// まで確認する（テスト網羅性レビューで指摘: 旧プリセットの間隔で再計算されて
		// いても、あるいは createdAt を起点にしていても、大小比較だけでは検出できない）。
		const systemIntervals = [1, 6, 24];
		const remaining = after.filter((r) => r.completedAt === null);
		expect(remaining.map((r) => r.step)).toEqual([1, 2]);
		for (const row of remaining) {
			const expected = nextReviewAt(completedAt, systemIntervals, row.step);
			expect(expected).toBeDefined();
			expect(row.scheduledAt.getTime()).toBe(expected?.getTime());
		}
	});

	// planReviewRecalculation の SELECT（完了済みステップ数の読み取り）と
	// db.batch() 実行の間に、別リクエストの completeReview が同じメモの対象
	// ステップを完了させる真の競合を再現する（interval-presets.test.ts の
	// 「translates a concurrent completion race into a ConflictError」と同型。
	// テスト網羅性レビューで指摘: この経路を正確性ではなくテストで裏付ける）。
	it('translates a concurrent completion race into a ConflictError instead of a raw DB error', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm', // ownerPreset の intervals: [1, 24]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
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

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// changeMemoPreset の SELECT（planReviewRecalculation 内)はこの時点で
				// 完了済みで、completedCount=0 を前提に step0 から INSERT しようとしている。
				// ここで step0 を完了させることで、その前提を古くする。
				await completeReview(db, ownerId, due.id);
				return originalBatch(queries);
			});

		try {
			await expect(
				// 編集フォームと同じく title・content を一緒に送る（正確性レビューで
				// 指摘: catch 節の復元が intervalPresetId だけを戻し、同じ呼び出しで
				// 確定していた title・content を戻し忘れていた回帰の再発防止）。
				changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
					title: 'updated title',
					content: 'updated content',
					intervalPresetId: systemPresetId // intervals: [1, 6, 24]
				})
			).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// バッチ全体がロールバックされ、memo は title・content・intervalPresetId の
		// 全フィールドが呼び出し前の状態のまま（一部だけ確定した部分適用になっていない）。
		const memoAfter = await getMemo(db, ownerId, memo.id);
		expect(memoAfter.title).toBe('m');
		expect(memoAfter.content).toBe('c');
		expect(memoAfter.intervalPresetId).toBe(ownerPresetId);
	});

	// Issue #85 の回帰テスト: updateCustomPresetIntervals（プリセット単位の一括変更）は
	// memos.updatedAt に一切触れない。そのため、changeMemoPreset の1) memo UPDATE（
	// updatedAt の楽観ロック）が通過した後・2) reviews の claim 実行前に、同じメモが
	// 使っているプリセット自体が別リクエストで一括変更された場合、updatedAt の
	// 楽観ロックだけでは検出できない。review_schedules.version の CAS
	// （commitReviewRecalculation・claimReviewSchedule）が唯一の防御線になることを
	// 確認する。
	it('detects a stale changeMemoPreset claim even when a concurrent bulk preset update races in (memos.updatedAt is untouched by it)', async () => {
		// changeMemoPreset の1) memo UPDATE（stage 1）は、この呼び出しの db.batch()
		// より前に memos.intervalPresetId を変更先（targetPreset）へ既に書き換えている。
		// そのため、割り込ませる一括変更（updateCustomPresetIntervals）の対象は
		// 変更前の ownerPresetId ではなく、この変更先 targetPreset でなければ
		// このメモを対象に含められない（collectAffectedMemoIds が現在の
		// intervalPresetId で絞り込むため）。
		const [targetPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'target', intervals: [1, 24] })
			.returning();
		if (!targetPreset) throw new Error('fixture setup failed');

		const memo = await createMemo(db, ownerId, {
			title: 'm',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// この時点で 1) の memo UPDATE は既に成功し、memos.intervalPresetId は
				// targetPreset.id になっている。changeMemoPreset の
				// planReviewRecalculation（未完了2件を前提にした SELECT）も完了済み。
				// ここで targetPreset 自体を一括変更し、このメモの reviews と
				// review_schedules.version を作り直す。memos.updatedAt には一切触れない。
				await updateCustomPresetIntervals(db, ownerId, targetPreset.id, '2h, 10h');
				return originalBatch(queries);
			});

		try {
			await expect(
				changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
					intervalPresetId: targetPreset.id
				})
			).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// memo は intervalPresetId が変更前のまま（updatedAt の楽観ロックだけでは
		// 検出できないはずのこの競合が、version の CAS によって正しく拒否されている）。
		const memoAfter = await getMemo(db, ownerId, memo.id);
		expect(memoAfter.intervalPresetId).toBe(ownerPresetId);

		// reviews は一括変更（bulk）側が作り直した2件のまま（changeMemoPreset の
		// claim は version 不一致で敗れ、DELETE/INSERT を一切実行していない）。
		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.completedAt === null)).toBe(true);
	});

	// catch 節の復元ガード（`eq(memos.updatedAt, thisChangeStamp)`）の否定側:
	// 1) の memo UPDATE が勝った直後・2) の reviews 再計算実行前に、別リクエストが
	// このメモを更に更新していた場合、復元はその別更新を上書きしてはならない
	// （テスト網羅性レビューで指摘）。
	it('does not overwrite a newer update when restoring after a failed reviews recalculation', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm', // ownerPreset の intervals: [1, 24]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
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

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// completeReview で unique 制約違反を発生させるのに加え、この呼び出しの
				// 1) が勝った後の memo をさらに書き換える「別の更新」を割り込ませる。
				await completeReview(db, ownerId, due.id);
				await db
					.update(memos)
					.set({ title: 'overwritten by someone else' })
					.where(eq(memos.id, memo.id));
				return originalBatch(queries);
			});

		try {
			await expect(
				changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
					intervalPresetId: systemPresetId // intervals: [1, 6, 24]
				})
			).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// 復元処理が thisChangeStamp と一致しない（＝別更新が既に上書きした）ため、
		// 復元 UPDATE 自体は0行に終わり、別更新の内容がそのまま残る。
		const memoAfter = await getMemo(db, ownerId, memo.id);
		expect(memoAfter.title).toBe('overwritten by someone else');
	});

	// 編集フォームは常に intervalPresetId を送るが、実際に選択が変わっていなければ
	// スケジュールを変更してはならない（完了条件: 「プリセットを変更しない更新では
	// スケジュールが変わらない」）。
	it('leaves reviews untouched when the submitted intervalPresetId matches the current one', async () => {
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

		const updated = await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			title: 'new title',
			intervalPresetId: ownerPresetId
		});
		expect(updated.title).toBe('new title');
		expect(updated.intervalPresetId).toBe(ownerPresetId);

		const after = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(after).toEqual(before);
	});

	it('updates title/content together with the preset change in the same call', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const updated = await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			title: 'new title',
			content: 'new content',
			intervalPresetId: systemPresetId
		});
		expect(updated.title).toBe('new title');
		expect(updated.content).toBe('new content');
		expect(updated.intervalPresetId).toBe(systemPresetId);
	});

	// 同時更新時は 409 になり、かつ memo・reviews のどちらか一方だけが反映される
	// 状態にならないこと（reviews は完全に手つかずのまま）を確認する。
	it('throws ConflictError on a stale expectedUpdatedAt and leaves memo and reviews untouched', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		// staleUpdatedAt は「このリクエストが最後に読んだ」とみなす基準時刻。
		// 「別のリクエストが先に確定させた」後の状態を、changeMemoPreset 内部が
		// 生成する thisChangeStamp（実行時点の実時刻）と衝突しない、既知の過去の
		// 固定値で直接作る。updateMemo 経由で本物の同時実行を模すと、両者の
		// `new Date()` がミリ秒精度の解像度で偶然同じ値になり得て、ガードが
		// たまたま真になってしまいテストが不安定になる（正確性レビューで指摘された
		// 「target値が偶然一致するレース」とは別の、テスト特有のタイミング衝突）。
		const staleUpdatedAt = new Date(memo.updatedAt.getTime() - 60_000);
		const winningUpdatedAt = new Date(memo.updatedAt.getTime() - 30_000);
		await db
			.update(memos)
			.set({ updatedAt: winningUpdatedAt, title: 'updated by someone else' })
			.where(eq(memos.id, memo.id));

		const reviewsBefore = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		await expect(
			changeMemoPreset(db, ownerId, memo.id, staleUpdatedAt, { intervalPresetId: systemPresetId })
		).rejects.toThrow(ConflictError);

		const memoAfter = await getMemo(db, ownerId, memo.id);
		expect(memoAfter.intervalPresetId).toBe(ownerPresetId);

		const reviewsAfter = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(reviewsAfter).toEqual(reviewsBefore);
	});

	// 正確性レビューで指摘された回帰テスト: 同じ変更先プリセットへの二重送信
	// （多重タブ・二重クリック等）で、負けたはずの2回目の呼び出しが「現在の
	// intervalPresetId が変更先と一致しているか」だけを見るガードだと、1回目が
	// 既にその値へ書き込んでいるため誤って真になり、負けた側の reviews 再計算まで
	// 実行されてしまうバグがあった。2段階更新への設計変更後は、2回目の呼び出しが
	// 読む existing.intervalPresetId は既に1回目が書き込んだ後の値であるため、
	// presetChanged が false と判定され「変更なしの no-op」として扱われる
	// （409 にはならない）。これは「プリセットを変更しない更新ではスケジュールが
	// 変わらない」という別の完了条件と同じ扱いであり、正しい挙動である。
	it('treats a second submission of the same already-applied target preset as a no-op, not a conflict', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});

		// 勝者が先に systemPresetId へ変更・確定した状態を直接作る。
		await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			intervalPresetId: systemPresetId // intervals: [1, 6, 24]
		});
		const reviewsAfterWinner = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		// 敗者は勝者より前の（今や古い）expectedUpdatedAt を使うが、変更先は
		// 勝者と同じ systemPresetId（多重タブでの二重送信を想定）。
		const result = await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			intervalPresetId: systemPresetId
		});
		expect(result.intervalPresetId).toBe(systemPresetId);

		const reviewsAfterLoser = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(reviewsAfterLoser).toEqual(reviewsAfterWinner);
	});

	// 正確性レビューで指摘された、より深刻な回帰テスト: 完了済みステップ数と
	// 新旧 intervals の組み合わせ次第では、既存の未完了行と負けた側の新ステップ
	// 番号が重ならず、unique 制約違反にすら頼れないケースがある（勝者が完了済み
	// ステップ数以下のプリセットへ縮小し未完了行が0件になり、敗者がそれより
	// 長いプリセットへ変更しようとする場合）。このケースでは、memo の UPDATE を
	// 先に確定させてから reviews を再計算する2段階設計そのものが唯一の防御線と
	// なる（DELETE/INSERT を1つの db.batch() にまとめ、既存行との偶然の衝突に
	// 頼っていた旧設計では検出できなかった）。
	it('does not silently apply a losing preset change even when no unique-constraint collision would occur', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		// 両ステップとも完了済みにし、未完了行を0件にする。
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.memoId, memo.id));
		const reviewsBefore = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();

		// 勝者が先に、完了済みステップ数(2)以下のプリセットへ変更する
		// （otherUserPresetId は intervals: [1] だが他ユーザー所有のため使えない。
		// ここでは新規に2ステップちょうどのプリセットを用意する）。
		const [shrinkPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'shrink', intervals: [1, 24] })
			.returning();
		if (!shrinkPreset) throw new Error('fixture setup failed');
		await changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
			intervalPresetId: shrinkPreset.id
		});

		// 敗者は勝者より前の（今や古い）expectedUpdatedAt を使い、
		// systemPresetId（intervals: [1, 6, 24]、3ステップ）へ変更しようとする。
		// 敗者からは新しく1件（step 2）を INSERT する必要があるが、既存の
		// 未完了行は0件（勝者の変更で全ステップ完了扱いのまま）なので、
		// unique 制約違反は起こらない。
		await expect(
			changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
				intervalPresetId: systemPresetId
			})
		).rejects.toThrow(ConflictError);

		const memoAfter = await getMemo(db, ownerId, memo.id);
		expect(memoAfter.intervalPresetId).toBe(shrinkPreset.id);

		const reviewsAfter = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(reviewsAfter).toEqual(reviewsBefore);
	});

	it('throws NotFoundError when changing the preset of another user memo', async () => {
		const memo = await createMemo(db, otherUserId, {
			title: 'title',
			content: 'content',
			intervalPresetId: otherUserPresetId
		});
		await expect(
			changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
				intervalPresetId: otherUserPresetId
			})
		).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError when changing the preset of an archived memo', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, memo.id);
		await expect(
			changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, { intervalPresetId: systemPresetId })
		).rejects.toThrow(NotFoundError);
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

	// Issue #85 の明示要件（アーカイブ時に version を更新する）の直接確認。
	// claim（memoIsNotArchived）側のガードだけでも既存の競合テストは通ってしまい、
	// この version bump 自体を外しても検出できていなかった（テスト網羅性レビューで
	// ミューテーションテストにより指摘）。
	it('bumps review_schedules.version when archiving', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'content',
			intervalPresetId: ownerPresetId
		});
		const [before] = await db
			.select({ version: reviewSchedules.version })
			.from(reviewSchedules)
			.where(eq(reviewSchedules.memoId, memo.id))
			.all();
		expect(before?.version).toBe(0);

		await archiveMemo(db, ownerId, memo.id);

		const [after] = await db
			.select({ version: reviewSchedules.version })
			.from(reviewSchedules)
			.where(eq(reviewSchedules.memoId, memo.id))
			.all();
		expect(after?.version).toBe(1);
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

	// Issue #85 の回帰テスト（テスト網羅性レビューで指摘）: アーカイブとの競合は
	// interval-presets.test.ts の bulk 経路（updateCustomPresetIntervals、
	// loadReviewRecalculationInputs 呼び出し自体を横取りしてバージョン取得より前に
	// アーカイブを割り込ませる形）でしか検証されていなかった。単一メモ経路
	// （changeMemoPreset）でも、planReviewRecalculation の SELECT 後・claim 実行前に
	// アーカイブされた場合、claim が正しく敗れて ConflictError になることを確認する
	// （この経路では archiveMemo 自身が review_schedules.version も進めるため、
	// version 不一致としても検出されるが、claim 自身の archivedAt チェックが
	// version の一致だけに依存しない独立した安全策になっていることの回帰でもある）。
	it('rejects a changeMemoPreset claim if the memo gets archived between the plan read and the claim', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24]
		});
		const [targetPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'target', intervals: [2, 5] })
			.returning();
		if (!targetPreset) throw new Error('fixture setup failed');

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// changeMemoPreset の 1) memo UPDATE・planReviewRecalculation の SELECT
				// はこの時点で完了済み。ここでこのメモをアーカイブする。
				await archiveMemo(db, ownerId, memo.id);
				return originalBatch(queries);
			});

		try {
			await expect(
				changeMemoPreset(db, ownerId, memo.id, memo.updatedAt, {
					intervalPresetId: targetPreset.id
				})
			).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// アーカイブ済みメモに未完了 reviews が復活していない
		// （claim の DELETE は素通りしても、INSERT 自体が実行されない）。
		const rows = await db.select().from(reviews).where(eq(reviews.memoId, memo.id)).all();
		expect(rows).toHaveLength(0);
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
