import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	and,
	createDb,
	eq,
	exists,
	gt,
	intervalPresets,
	isNull,
	memos,
	reviews,
	reviewSchedules,
	sql,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { ConflictError, NotFoundError } from './errors';
import { createMemo } from './memos';
import {
	claimReviewSchedule,
	completeReview,
	commitReviewRecalculation,
	computeReviewRecalculation,
	getCurrentPendingReview,
	getDueReviewDetail,
	listDueReviews,
	listReviewSchedule,
	loadReviewRecalculationInputs,
	planReviewRecalculation
} from './reviews';
import { createTestUser } from './test-helpers';

let db: Db;
let ownerId: string;
let otherUserId: string;
let ownerPresetId: string;

// createMemo が生成する reviews は intervals（時間単位）ぶん未来の scheduledAt を持つため、
// 「期限が来ている」状態を作るには直接過去の日時へ書き換える。
async function makeAllReviewsDue(db: Db, memoId: string, now = new Date()) {
	await db
		.update(reviews)
		.set({ scheduledAt: new Date(now.getTime() - 1000) })
		.where(eq(reviews.memoId, memoId));
}

// createMemo → makeAllReviewsDue という頻出パターンをまとめる。
async function createDueMemo(
	userId: string,
	presetId: string,
	overrides: { title?: string; content?: string } = {}
) {
	const memo = await createMemo(db, userId, {
		title: overrides.title ?? 'memo',
		content: overrides.content ?? 'c',
		intervalPresetId: presetId
	});
	await makeAllReviewsDue(db, memo.id);
	return memo;
}

// createDueMemo に加えて listDueReviews まで呼び、先頭要素（対象 review）を返す。
async function createDueReview(
	userId: string,
	presetId: string,
	overrides: { title?: string; content?: string } = {}
) {
	const memo = await createDueMemo(userId, presetId, overrides);
	const result = await listDueReviews(db, userId);
	const due = result.items[0];
	if (!due) throw new Error('fixture setup failed');
	return { memo, result, due };
}

// 他ユーザー所有のプリセット・メモ・期限到来 review を用意する。
async function createOtherUserDueReview() {
	const [otherPreset] = await db
		.insert(intervalPresets)
		.values({ userId: otherUserId, name: 'other', intervals: [1] })
		.returning();
	if (!otherPreset) throw new Error('fixture setup failed');
	return createDueReview(otherUserId, otherPreset.id, { title: 'other' });
}

beforeEach(async () => {
	db = createDb(env.DB);
	ownerId = await createTestUser(db);
	otherUserId = await createTestUser(db);

	const [ownerPreset] = await db
		.insert(intervalPresets)
		.values({ userId: ownerId, name: 'owner preset', intervals: [1, 24, 72] })
		.returning();
	if (!ownerPreset) throw new Error('fixture setup failed');
	ownerPresetId = ownerPreset.id;
});

describe('listDueReviews', () => {
	it('lists only the smallest incomplete step per memo, once it is due', async () => {
		const { result } = await createDueReview(ownerId, ownerPresetId);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.step).toBe(0);
		expect(result.items[0]?.memoTitle).toBe('memo');
		expect(result.total).toBe(1);
	});

	it('excludes reviews that are not yet due', async () => {
		await createMemo(db, ownerId, { title: 'memo', content: 'c', intervalPresetId: ownerPresetId });
		// makeAllReviewsDue を呼ばないため、全ステップが未来のまま。
		const result = await listDueReviews(db, ownerId);
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('excludes another user memos', async () => {
		await createOtherUserDueReview();

		const result = await listDueReviews(db, ownerId);
		expect(result.items).toEqual([]);
		// 一覧（items）だけでなく件数クエリ側にも userId フィルタが効いていることを確認する
		// （バナーの件数と一覧の定義は常に一致する、という不変条件の裏側）。
		expect(result.total).toBe(0);
	});

	// steps は 0, 1, 2, ... の順に欠番なく完了する不変条件（docs/schema.md）。due 判定を
	// 「未完了の最小 step」を求めるサブクエリの外側で行っているため、まだ期限前の
	// 最小未完了ステップ（この場合 step0）がある限り、期限切れの後続ステップ（step1）を
	// 追い越して表示することはない。
	//
	// makeAllReviewsDue で全ステップを一律に過去日時へ書き換えるフィクスチャでは、
	// due 判定をサブクエリの内側（`GROUP BY` の対象を先に scheduledAt <= now で
	// 絞ってから min(step) を取る実装）に変えても min(step) は常に 0 のままになり、
	// この2つの実装を区別できない。実際にそのように改変して再実行しても本テストは
	// 変わらず通ってしまうことをテスト網羅性レビューで指摘された。区別するには
	// 「最小未完了 step だけがまだ期限前」という状態を作る必要がある。
	it('does not surface a later step even if it is also due while an earlier step remains incomplete', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		const step1 = rows.find((r) => r.step === 1);
		if (!step1) throw new Error('fixture setup failed');
		// step0（最小の未完了 step）は期限前のまま残し、step1 だけを期限切れにする。
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(Date.now() - 1000) })
			.where(eq(reviews.id, step1.id));

		const result = await listDueReviews(db, ownerId);
		// due 判定をサブクエリの外側で行う実装では、min(step)=0 の行はまだ due ではないため
		// 対象にならず、期限切れの step1 を代わりに表示することもない。
		expect(result.items).toEqual([]);
	});

	it('surfaces the next step once the previous one is completed', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id);

		// 完了時に残りステップは完了時刻起点で再アンカリングされる（#17 の設計判断）ため、
		// 次のステップは通常まだ未来。改めて過去に書き換えて「次も期限が来た」状態にする。
		await makeAllReviewsDue(db, memo.id);
		const result = await listDueReviews(db, ownerId);
		expect(result.items.map((r) => r.step)).toEqual([1]);
	});

	it('counts using the same definition as the list (one row per memo, not raw review rows)', async () => {
		// intervals は [1, 24, 72] の3ステップ分あり、全行を期限切れにしても
		// 一覧・件数ともに「そのメモにつき1件」に留まるはず。
		const { result } = await createDueReview(ownerId, ownerPresetId);
		expect(result.total).toBe(1);
		expect(result.items).toHaveLength(1);
	});

	it('orders oldest scheduledAt first', async () => {
		const older = await createMemo(db, ownerId, {
			title: 'older',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const newer = await createMemo(db, ownerId, {
			title: 'newer',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const now = new Date();
		// 2つの review に異なる scheduledAt を与え、実際に古い順に並ぶことを検証する
		// （前回のテストは a/b に同一時刻を与えていたため、tie-break のみを検証しており
		// scheduledAt 昇順であること自体は検証できていなかった。テスト網羅性レビューで指摘）。
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() - 2000) })
			.where(eq(reviews.memoId, older.id));
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() - 1000) })
			.where(eq(reviews.memoId, newer.id));

		const result = await listDueReviews(db, ownerId);
		expect(result.items.map((r) => r.memoId)).toEqual([older.id, newer.id]);
	});

	it('breaks scheduledAt ties using the review id', async () => {
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
		const now = new Date();
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() - 1000) })
			.where(eq(reviews.memoId, a.id));
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() - 1000) })
			.where(eq(reviews.memoId, b.id));

		// タイブレークのキーは reviews.id（一覧の各行自身の id）であり、memos.id
		// ではない（memoId の大小と review id の大小に相関はない）。
		const [aReview] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(eq(reviews.memoId, a.id), eq(reviews.step, 0)))
			.all();
		const [bReview] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(eq(reviews.memoId, b.id), eq(reviews.step, 0)))
			.all();
		if (!aReview || !bReview) throw new Error('fixture setup failed');

		const result = await listDueReviews(db, ownerId);
		const expectedOrder = [aReview.id, bReview.id].sort();
		expect(result.items.map((r) => r.id)).toEqual(expectedOrder);
	});

	it('paginates with limit/offset without overlap or omission', async () => {
		const memoList = [];
		for (let i = 0; i < 3; i++) {
			memoList.push(await createDueMemo(ownerId, ownerPresetId, { title: `memo ${i}` }));
		}

		const page1 = await listDueReviews(db, ownerId, { limit: 2, offset: 0 });
		const page2 = await listDueReviews(db, ownerId, { limit: 2, offset: 2 });
		expect(page1.items).toHaveLength(2);
		expect(page2.items).toHaveLength(1);
		expect(page1.total).toBe(3);

		const seenIds = [...page1.items, ...page2.items].map((r) => r.memoId).sort();
		expect(seenIds).toEqual(memoList.map((m) => m.id).sort());
	});

	it('defaults to a limit of 10 when not specified', async () => {
		for (let i = 0; i < 12; i++) {
			await createDueMemo(ownerId, ownerPresetId, { title: `memo ${i}` });
		}
		const result = await listDueReviews(db, ownerId);
		expect(result.limit).toBe(10);
		expect(result.items).toHaveLength(10);
		expect(result.total).toBe(12);
	});

	// listMemos（#13）と同じ clamp() を共有しているため、境界値の挙動も揃っている
	// ことを確認する（apps/web/src/lib/server/memos.test.ts の同種テストを踏襲）。
	it('clamps a limit above the maximum down to 100', async () => {
		const result = await listDueReviews(db, ownerId, { limit: 1000 });
		expect(result.limit).toBe(100);
	});

	it('clamps a non-positive limit up to 1', async () => {
		const zero = await listDueReviews(db, ownerId, { limit: 0 });
		const negative = await listDueReviews(db, ownerId, { limit: -5 });
		expect(zero.limit).toBe(1);
		expect(negative.limit).toBe(1);
	});

	it('clamps a negative offset up to 0', async () => {
		const result = await listDueReviews(db, ownerId, { offset: -10 });
		expect(result.offset).toBe(0);
	});

	it('returns an empty page when offset is past the total', async () => {
		await createDueMemo(ownerId, ownerPresetId, { title: 'only' });
		const result = await listDueReviews(db, ownerId, { offset: 50 });
		expect(result.items).toEqual([]);
		expect(result.total).toBe(1);
	});

	// アーカイブ済みメモの未完了 reviews は archiveMemo（#16）が削除するため理屈上は
	// 発生しないが、この不変条件は archivedAt を書く経路が archiveMemo のみである
	// ことに依存している（docs/schema.md）。archiveMemo を経由せず直接 archivedAt を
	// 書き込むことで、この防御が実際に効いていることを検証する。
	it('excludes reviews belonging to an archived memo even if they were not cleaned up', async () => {
		const memo = await createDueMemo(ownerId, ownerPresetId);
		await db.update(memos).set({ archivedAt: new Date() }).where(eq(memos.id, memo.id));

		const result = await listDueReviews(db, ownerId);
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	// 受け入れ条件「『復習した』を押すと一覧から消え」に対応する回帰テスト。
	it('no longer surfaces a memo once its due step has been completed', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id);

		// 再アンカリングにより次のステップの scheduledAt は未来になるため、
		// 再度 makeAllReviewsDue しない限り一覧・件数から完全に消える。
		const result = await listDueReviews(db, ownerId);
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});
});

describe('completeReview', () => {
	it('sets completedAt and returns the memo title', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);

		const result = await completeReview(db, ownerId, due.id);
		expect(result.memoTitle).toBe('memo');

		const [row] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(row?.completedAt).not.toBeNull();
	});

	// 一覧を経由しない URL 直打ちや POST でも、期限前のステップを完了して復習間隔を
	// 迂回できないことを検証する。再アンカリング前に配信済みだった通知から同じ review id を
	// 開くケースでも、このサーバー側の検証が必要になる。
	it('rejects completing the current step before its scheduledAt has arrived', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const [step0] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.all();
		if (!step0) throw new Error('fixture setup failed');

		await expect(completeReview(db, ownerId, step0.id)).rejects.toThrow(NotFoundError);

		const [row] = await db.select().from(reviews).where(eq(reviews.id, step0.id)).all();
		expect(row?.completedAt).toBeNull();
	});

	// 再アンカリング（gt(reviews.step, target.step)）が、対象ステップより前の
	// 既に完了済みステップを巻き込まないことを検証する（テスト網羅性レビューで、
	// 常に step0 からしか完了させていないテストしかなく、この境界が未検証だと指摘された）。
	it('does not touch an earlier, already-completed step when completing a later one', async () => {
		const [fourStepPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'four-step', intervals: [1, 24, 72, 168] })
			.returning();
		if (!fourStepPreset) throw new Error('fixture setup failed');
		const { memo, due: step0 } = await createDueReview(ownerId, fourStepPreset.id);
		await completeReview(db, ownerId, step0.id);

		const [completedStep0Before] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, step0.id))
			.all();
		if (!completedStep0Before) throw new Error('fixture setup failed');

		// step1 だけを期限切れにする（makeAllReviewsDue は完了済み行の scheduledAt も
		// 書き換えてしまい、この後の「step0 は変化しない」検証を汚染するため使わない）。
		const [step1Row] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)))
			.all();
		if (!step1Row) throw new Error('fixture setup failed');
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(Date.now() - 1000) })
			.where(eq(reviews.id, step1Row.id));

		const listed = await listDueReviews(db, ownerId);
		const step1 = listed.items[0];
		if (!step1) throw new Error('fixture setup failed');
		expect(step1.step).toBe(1);
		await completeReview(db, ownerId, step1.id);

		const [completedStep0After] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, step0.id))
			.all();
		// 完了済みの step0 は completedAt・scheduledAt とも変化しない
		// （gt により対象より後のステップだけが再アンカリングの対象になる）。
		expect(completedStep0After?.completedAt?.getTime()).toBe(
			completedStep0Before.completedAt?.getTime()
		);
		expect(completedStep0After?.scheduledAt.getTime()).toBe(
			completedStep0Before.scheduledAt.getTime()
		);
	});

	// ユーザー承認済みの設計判断（docs/design-decisions.md #17）: 放置していた期間を
	// 引きずらないよう、残り未完了ステップは完了時刻を起点に再計算し、notifiedAt もクリアする。
	it('re-anchors remaining steps from completedAt and clears notifiedAt', async () => {
		const memo = await createDueMemo(ownerId, ownerPresetId); // intervals: [1, 24, 72]
		await db.update(reviews).set({ notifiedAt: new Date() }).where(eq(reviews.memoId, memo.id));

		const listed = await listDueReviews(db, ownerId);
		const due = listed.items[0];
		if (!due) throw new Error('fixture setup failed');
		const before = new Date();
		const completion = await completeReview(db, ownerId, due.id);
		const after = new Date();

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		const step1 = rows.find((r) => r.step === 1);
		const step2 = rows.find((r) => r.step === 2);
		if (!step1 || !step2) throw new Error('fixture setup failed');

		// step1 は completedAt + 24h、step2 は completedAt + 72h に再計算される。
		expect(step1.scheduledAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 24 * 3600_000);
		expect(step1.scheduledAt.getTime()).toBeLessThanOrEqual(after.getTime() + 24 * 3600_000);
		expect(step2.scheduledAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 72 * 3600_000);
		expect(step2.scheduledAt.getTime()).toBeLessThanOrEqual(after.getTime() + 72 * 3600_000);
		expect(step1.notifiedAt).toBeNull();
		expect(step2.notifiedAt).toBeNull();
		expect(completion.nextScheduledAt?.getTime()).toBe(step1.scheduledAt.getTime());
	});

	it('returns nextScheduledAt of null when completing the final step', async () => {
		const [singleStepPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'single', intervals: [1] })
			.returning();
		if (!singleStepPreset) throw new Error('fixture setup failed');
		const { due } = await createDueReview(ownerId, singleStepPreset.id);

		const result = await completeReview(db, ownerId, due.id);
		expect(result.nextScheduledAt).toBeNull();
	});

	it('throws NotFoundError for another user review', async () => {
		const { due } = await createOtherUserDueReview();
		await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(NotFoundError);
	});

	it('throws when the review does not exist', async () => {
		await expect(completeReview(db, ownerId, crypto.randomUUID())).rejects.toThrow(NotFoundError);
	});

	it('throws when the review has already been completed', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id);

		await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(ConflictError);
	});

	// docs/schema.md が #17 に委ねた不変条件（常に最小の未完了 step からのみ完了できる）の
	// 防御。一覧は常にこの条件を満たす行しか見せないため通常到達しないが、review id を
	// 直接指定した場合の防御を検証する。
	it('rejects completing a later step while an earlier step is still incomplete', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		const step1 = rows.find((r) => r.step === 1);
		if (!step1) throw new Error('fixture setup failed');
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(Date.now() - 1000) })
			.where(eq(reviews.id, step1.id));

		await expect(completeReview(db, ownerId, step1.id)).rejects.toThrow(ConflictError);
	});

	it('throws NotFoundError for a review belonging to an archived memo', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await db.update(memos).set({ archivedAt: new Date() }).where(eq(memos.id, memo.id));

		await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(NotFoundError);
	});

	// 事前 SELECT では期限到来済みでも、UPDATE までの間に #18 の再計算等で予定が未来へ
	// 移動し得る。UPDATE 自体の due 条件が、古い画面からの完了を防ぐことを検証する。
	it('rejects completion when the review is rescheduled into the future before the update', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);
		const futureScheduledAt = new Date(Date.now() + 3600_000);
		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				await db
					.update(reviews)
					.set({ scheduledAt: futureScheduledAt })
					.where(eq(reviews.id, due.id));
				return originalBatch(queries);
			});

		try {
			await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		const [row] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(row?.completedAt).toBeNull();
		expect(row?.scheduledAt.getTime()).toBe(futureScheduledAt.getTime());
	});

	// completeReview の SELECT（存在・完了確認）と db.batch() の UPDATE の間に別リクエストが
	// 割り込む真の競合。直列に2回呼ぶだけでは SELECT 時点のチェックしか踏まないため、
	// Promise.all で本当に同時実行させる（memos.test.ts の createMemo 冪等性テストと同型）。
	it('only lets one of two concurrent completions of the same review succeed', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);

		const results = await Promise.allSettled([
			completeReview(db, ownerId, due.id),
			completeReview(db, ownerId, due.id)
		]);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		// 敗者側が ConflictError（→ 409）であることまで確認する。素の Error に壊れて
		// 500 になる回帰を検出できるようにする（テスト網羅性レビューで指摘）。
		expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);

		const [row] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(row?.completedAt).not.toBeNull();
	});

	// 敗者側のバッチが、勝者の completedAt とは異なる自分自身の completedAt を起点に
	// 残りステップを再アンカリングしてしまわないこと（Codex のレビューで指摘された回帰）。
	// db.batch は先頭 UPDATE（completeCurrent）が0件更新でもエラーにならないため、
	// このガードがないと敗者側の再アンカリング UPDATE だけが実行されてしまう。
	//
	// 単に Promise.allSettled で2回同時に呼ぶだけでは、どちらのバッチが先にコミット
	// されるかも、両者の completedAt が異なるミリ秒になるかも保証されない（実測で
	// ガードを外してもこのテストが再現なしにパスすることが多かった）。db.batch を
	// 横取りし、先にバッチへ到達した方（=勝者）を完全にコミットさせてから、後から
	// 来た方（=敗者）のバッチを実行させることで、「敗者のバッチが勝者の完了確定後に
	// 実行される」という競合状態を決定的に再現する。
	it('does not let the loser of a concurrent completion re-anchor remaining steps from its own completedAt', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		const [nextStepRow] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), gt(reviews.step, due.step)))
			.orderBy(reviews.step)
			.all();
		if (!nextStepRow) throw new Error('fixture setup failed');

		const originalBatch = db.batch.bind(db);
		let winnerBatchStarted = false;
		let loserReachedBatch = false;
		let resolveWinnerDone: () => void;
		const winnerDone = new Promise<void>((resolve) => {
			resolveWinnerDone = resolve;
		});
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementation(async (queries: Parameters<typeof originalBatch>[0]) => {
				if (!winnerBatchStarted) {
					winnerBatchStarted = true;
					const result = await originalBatch(queries);
					resolveWinnerDone();
					return result;
				}
				loserReachedBatch = true;
				await winnerDone;
				return originalBatch(queries);
			});

		let results: PromiseSettledResult<Awaited<ReturnType<typeof completeReview>>>[];
		try {
			results = await Promise.allSettled([
				completeReview(db, ownerId, due.id),
				completeReview(db, ownerId, due.id)
			]);
		} finally {
			batchSpy.mockRestore();
		}
		const fulfilled = results.filter(
			(r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof completeReview>>> =>
				r.status === 'fulfilled'
		);
		expect(fulfilled).toHaveLength(1);
		const winner = fulfilled[0]?.value;
		if (!winner) throw new Error('expected exactly one winner');

		const [persistedTarget] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		if (!persistedTarget?.completedAt) throw new Error('target was not completed');
		// 勝者が返した completedAt こそが実際に保存された値であること。
		expect(persistedTarget.completedAt.getTime()).toBe(winner.completedAt.getTime());

		// 敗者の最初の存在確認 SELECT が、勝者のバッチ確定より先に「未完了」を見た場合に
		// のみ、敗者は db.batch まで到達する（そうでなければ SELECT の時点で
		// ConflictError になり早期return するため、再アンカリングの競合自体が発生しない）。
		// db.batch 呼び出しへの到達順序は上のスパイで固定しているが、その手前の SELECT の
		// タイミングまでは制御できないため、この分岐が起きたかどうかを確認したうえで
		// 意味のあるケースでだけ再アンカリング結果を検証する（起きなかった場合にまで
		// 厳密な比較を要求すると、このテストが実行のたびに不安定に失敗する）。
		if (!loserReachedBatch) return;

		const [persistedNextStep] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, nextStepRow.id))
			.all();
		const expectedScheduledAt = nextReviewAt(
			persistedTarget.completedAt,
			[1, 24, 72],
			nextStepRow.step
		);
		if (!expectedScheduledAt) throw new Error('expected re-anchoring to be possible');
		// 再アンカリングは、実際に保存された completedAt（= 勝者の値）だけを起点にしていること。
		// 敗者の completedAt を起点にしていたら、この値とはずれる。
		expect(persistedNextStep?.scheduledAt.getTime()).toBe(expectedScheduledAt.getTime());
		expect(persistedNextStep?.notifiedAt).toBeNull();
	});

	// 上のテストは敗者が実際に db.batch まで到達した場合にのみ再アンカリング結果を
	// 検証するため、検出力が実行タイミングに依存する。ここでは completeReview を介さず、
	// reviews.ts の再アンカリング UPDATE と同じ形（`exists` ガード付き）の SQL を直接
	// 組み立て、ガードが常に正しく機能することを決定的に検証する。
	it('the re-anchor guard rejects an update whose completedAt does not match the persisted value', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		const [nextStepRow] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), gt(reviews.step, due.step)))
			.orderBy(reviews.step)
			.all();
		if (!nextStepRow) throw new Error('fixture setup failed');

		// 勝者役: 対象 review を completedAt = winnerCompletedAt で先に完了させる。
		const winnerCompletedAt = new Date();
		await db.update(reviews).set({ completedAt: winnerCompletedAt }).where(eq(reviews.id, due.id));

		// 敗者役: 異なる completedAt（winnerCompletedAt + 1000ms）を使い、
		// reviews.ts の wonThisCompletion と同じ形のガード付き UPDATE を実行する。
		const loserCompletedAt = new Date(winnerCompletedAt.getTime() + 1000);
		const staleGuard = exists(
			db
				.select({ one: sql`1` })
				.from(reviews)
				.where(and(eq(reviews.id, due.id), eq(reviews.completedAt, loserCompletedAt)))
		);
		const newScheduledAt = nextReviewAt(loserCompletedAt, [1, 24, 72], nextStepRow.step);
		if (!newScheduledAt) throw new Error('fixture setup failed');
		await db
			.update(reviews)
			.set({ scheduledAt: newScheduledAt, notifiedAt: null })
			.where(and(eq(reviews.id, nextStepRow.id), isNull(reviews.completedAt), staleGuard));

		// ガードが機能していれば、persisted completedAt（winnerCompletedAt）と
		// staleGuard が要求する completedAt（loserCompletedAt）が一致しないため
		// 0件更新になり、scheduledAt は変化しない。
		const [after] = await db.select().from(reviews).where(eq(reviews.id, nextStepRow.id)).all();
		expect(after?.scheduledAt.getTime()).toBe(nextStepRow.scheduledAt.getTime());
	});

	// 残り未完了ステップの再アンカリングに使う intervals は、そのメモの現在の
	// intervalPresetId が指すプリセットの値でなければならない（docs/design-decisions.md
	// #17節）。作成時に使ったプリセットのキャッシュを誤って使い回していないかを検証する。
	// intervalPresetId の変更は #82 以降 changeMemoPreset（reviews も同時に作り直す）
	// を経由するため、ここでは「reviews は作成時のまま、intervalPresetId だけが
	// 変わっている」状態を意図的に直接 UPDATE で作る（#82 のデプロイ前に発生し得た
	// 既存データの再現。changeMemoPreset 経由ではこの状態にならない）。
	it('re-anchors using the current intervalPresetId, not the one used at creation', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const [newPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'new preset', intervals: [1, 1000] })
			.returning();
		if (!newPreset) throw new Error('fixture setup failed');
		await db.update(memos).set({ intervalPresetId: newPreset.id }).where(eq(memos.id, memo.id));

		await makeAllReviewsDue(db, memo.id);
		const listed = await listDueReviews(db, ownerId);
		const due = listed.items[0];
		if (!due) throw new Error('fixture setup failed');
		const before = new Date();
		await completeReview(db, ownerId, due.id);

		const [step1] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)))
			.all();
		if (!step1) throw new Error('fixture setup failed');
		// 新プリセットの intervals[1] は 1000時間。作成時のプリセット（intervals[1]=24h）を
		// 使っていたら、この範囲には収まらない。
		expect(step1.scheduledAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 999 * 3600_000);
	});

	// #18 が扱うべきエッジケース（docs/schema.md）: プリセットの要素数が既存の
	// 未完了ステップ数を下回る場合の再計算方針は未確定。#17 としては、この不整合を
	// 理由に「対象ステップの完了」自体を失敗させないことを確認する（advisor レビューで
	// 指摘された、完了操作が恒久的に失敗し続ける不具合の回帰テスト）。
	// あわせて、再アンカリングできなかった次のステップを「全ステップ完了」と誤認しない
	// ことも検証する（正確性・テスト網羅性の両レビューで指摘: 完了直後に一覧へ戻ると
	// 同じメモが即座に復活するにもかかわらず、修正前は nextScheduledAt が null になり
	// UI が「このメモの復習はすべて完了しました」という事実と異なるメッセージを表示していた）。
	// #82 以降 changeMemoPreset は reviews も同時に作り直すためこの不整合状態には
	// ならないが、#82 のデプロイ前の既存データでは起こり得るため、直接 UPDATE で再現する。
	it('still completes the target step, and does not misreport it as fully done, when the current preset is too short to re-anchor a later step', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const [shortPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'short', intervals: [1] })
			.returning();
		if (!shortPreset) throw new Error('fixture setup failed');
		await db.update(memos).set({ intervalPresetId: shortPreset.id }).where(eq(memos.id, memo.id));

		await makeAllReviewsDue(db, memo.id);
		const listBefore = await listDueReviews(db, ownerId);
		const due = listBefore.items[0];
		if (!due) throw new Error('fixture setup failed');
		const [step1Before] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)))
			.all();
		if (!step1Before) throw new Error('fixture setup failed');

		const result = await completeReview(db, ownerId, due.id);
		expect(result.memoTitle).toBe('memo');
		// 次のステップ（step1）はプリセット短縮により再アンカリングできず古い scheduledAt の
		// まま残っているだけで、「全ステップ完了」ではない。null を返すと画面に誤った
		// 完了メッセージが表示される。据え置かれた値は完了前の scheduledAt と完全に
		// 一致すること（別の値に変わっていないこと）まで確認する。
		expect(result.nextScheduledAt).not.toBeNull();
		expect(result.nextScheduledAt?.getTime()).toBe(step1Before.scheduledAt.getTime());

		const [row] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(row?.completedAt).not.toBeNull();

		const [step1After] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, step1Before.id))
			.all();
		expect(step1After?.scheduledAt.getTime()).toBe(step1Before.scheduledAt.getTime());
		// notifiedAt も再アンカリングされなかった扱いで、書き換えられていないこと。
		expect(step1After?.notifiedAt).toBe(step1Before.notifiedAt);
		// step2（新プリセットの intervals には存在しない）は再アンカリングされず、
		// 元の scheduledAt のまま残る。
		const [step2] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 2)))
			.all();
		expect(step2?.completedAt).toBeNull();

		// 一覧を再度引くと、同じメモがすぐに復活する（据え置かれた scheduledAt が
		// 依然として期限切れのため）。「完了しました」の直後に一覧へ戻ってもまだ
		// 残っている、という一貫した体験になっていることを確認する。
		const listAfter = await listDueReviews(db, ownerId);
		expect(listAfter.total).toBe(1);
		expect(listAfter.items[0]?.step).toBe(1);
	});

	// Issue #85 の回帰テスト（テスト網羅性レビューで指摘）: interval-presets.test.ts・
	// memos.test.ts の既存競合テストはいずれも「completeReview が先に割り込んで
	// プリセット変更側の claim を負けさせる」方向のみを検証していた。逆方向
	// （プリセット変更側の claim が先に成立し、completeReview の書き込みが古い
	// version を前提にしたまま実行される）も同じ ConflictError になることを確認する。
	it('rejects completion when a concurrent claim (e.g. a preset change) advances the schedule version first', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// completeReview の冒頭 SELECT（scheduleVersion=0 の取得）はこの時点で
				// 完了済み。ここで別リクエストの claim（プリセット変更等）を先に成立させ、
				// version を進める（新規メモの初期 version は必ず0）。
				const won = await claimReviewSchedule(db, memo.id, 0);
				if (!won) throw new Error('fixture setup failed: claim should win on a fresh memo');
				return originalBatch(queries);
			});

		try {
			await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// completeReview 自身の書き込み（completedAt）はコミットされていない
		// （割り込んだ claim の DELETE で対象行自体が既に削除されているため、
		// そもそも見つからない）。
		const rows = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(rows).toHaveLength(0);
	});

	// 上のテストは claim の DELETE が対象 reviews 行自体を消すため、completeCurrent が
	// 0行になるのが「scheduleVersionMatches の不一致」なのか「対象行が無いだけ」なのか
	// 区別できない（テスト網羅性レビューで指摘・ミューテーションテストで検出:
	// scheduleVersionMatches をガードから外しても既存テストが全て通ってしまっていた）。
	// ここでは reviews 行を消さずに review_schedules.version だけを直接進めることで、
	// scheduleVersionMatches 単体のガードを分離して検証する。
	it('rejects completion when review_schedules.version alone has advanced (reviews row untouched)', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);

		const originalBatch = db.batch.bind(db);
		const batchSpy = vi
			.spyOn(db, 'batch')
			.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
				// completeReview の冒頭 SELECT（scheduleVersion=0 の取得）はこの時点で
				// 完了済み。ここで reviews 行には触れず review_schedules.version だけを
				// 進める（claimReviewSchedule のような DELETE を伴わない、archiveMemo の
				// version bump 相当の割り込み）。
				await db
					.update(reviewSchedules)
					.set({ version: sql`${reviewSchedules.version} + 1` })
					.where(eq(reviewSchedules.memoId, memo.id));
				return originalBatch(queries);
			});

		try {
			await expect(completeReview(db, ownerId, due.id)).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// completeCurrent の WHERE が version 不一致で弾いたため、completedAt は
		// 立っていない（reviews 行自体は削除されていないので、対象行が無いことによる
		// 失敗ではないと分かる）。
		const [row] = await db.select().from(reviews).where(eq(reviews.id, due.id)).all();
		expect(row?.completedAt).toBeNull();
	});

	// Issue #85 の回帰テスト（正確性レビューで指摘）: review_schedules 行が無い
	// メモ（migrate〜deploy window の既存データを想定）でも、completeReview が
	// 恒久的に NotFoundError になったりせず、治癒（ensureReviewScheduleExists）の
	// 上で通常どおり完了できることを確認する。
	it('heals a memo missing its review_schedules row before completing it', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await db.delete(reviewSchedules).where(eq(reviewSchedules.memoId, memo.id));

		const result = await completeReview(db, ownerId, due.id);
		expect(result.memoId).toBe(memo.id);

		const [healedRow] = await db
			.select({ version: reviewSchedules.version })
			.from(reviewSchedules)
			.where(eq(reviewSchedules.memoId, memo.id))
			.all();
		expect(healedRow?.version).toBe(1);
	});
});

describe('getDueReviewDetail', () => {
	it('returns the memo content for the actionable review', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId, { content: '本文' });

		const detail = await getDueReviewDetail(db, ownerId, due.id);
		expect(detail.memoTitle).toBe('memo');
		expect(detail.memoContent).toBe('本文');
		expect(detail.step).toBe(0);
		expect(detail.scheduledAt.getTime()).toBe(due.scheduledAt.getTime());
	});

	// ownerPreset の intervals: [1, 24, 72] （3 ステップ）。
	it('returns totalSteps and a preview of the next scheduledAt', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId, { content: '本文' });

		const before = Date.now();
		const detail = await getDueReviewDetail(db, ownerId, due.id);
		const after = Date.now();

		expect(detail.totalSteps).toBe(3);
		// step 0 を今完了したとみなした場合の次ステップ（step 1、interval 24h）の予定時刻。
		expect(detail.previewNextScheduledAt).not.toBeNull();
		const previewMs = detail.previewNextScheduledAt?.getTime() ?? 0;
		expect(previewMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
		expect(previewMs).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
	});

	it('returns null preview when the current step is the final one', async () => {
		const singlePreset = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'single-step', intervals: [1] })
			.returning();
		const presetId = singlePreset[0]?.id;
		if (!presetId) throw new Error('fixture setup failed');
		const { due } = await createDueReview(ownerId, presetId, { content: '本文' });

		const detail = await getDueReviewDetail(db, ownerId, due.id);
		expect(detail.totalSteps).toBe(1);
		expect(detail.previewNextScheduledAt).toBeNull();
	});

	// 上のテストは「作成直後に唯一のステップ」という縮退ケースのみを見ていた
	// （テスト網羅性レビューで指摘）。複数ステップのプリセットで前段まで完了済みの、
	// より実態に近い「進行後の最終ステップ」を検証する。
	it('returns null preview for the final step of a multi-step preset after earlier steps are completed', async () => {
		const memo = await createDueMemo(ownerId, ownerPresetId, { content: '本文' }); // intervals: [1, 24, 72]

		let listed = await listDueReviews(db, ownerId);
		await completeReview(db, ownerId, listed.items[0]!.id); // step 0 完了

		await makeAllReviewsDue(db, memo.id);
		listed = await listDueReviews(db, ownerId);
		await completeReview(db, ownerId, listed.items[0]!.id); // step 1 完了

		await makeAllReviewsDue(db, memo.id);
		listed = await listDueReviews(db, ownerId);
		const finalDue = listed.items[0];
		if (!finalDue) throw new Error('fixture setup failed');

		const detail = await getDueReviewDetail(db, ownerId, finalDue.id);
		expect(detail.step).toBe(2);
		expect(detail.totalSteps).toBe(3);
		expect(detail.previewNextScheduledAt).toBeNull();
	});

	// プリセット変更で intervals が短くなっても、reviews 側に残っている未完了ステップの
	// 実数を totalSteps に反映し、次ステップの存在有無（previewNextScheduledAt の null 判定）が
	// completeReview の実際の結果と矛盾しないことを検証する（正確性レビューで指摘）。
	// このテストが通る経路は「再アンカリング不能によるフォールバック（既存の scheduledAt を
	// そのまま採用する）」分岐のみである。previewNextScheduledAt が nextReviewAt(now, ...) で
	// 実際に再計算される（フォールバックしない）経路は、基準時刻が now と completedAt で
	// 異なるため厳密な一致を検証できず、このテストの対象外（テスト網羅性レビューで指摘）。
	it('keeps totalSteps and the re-anchor-fallback branch of the preview consistent with completeReview when the preset has been shortened mid-progress', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: '本文',
			intervalPresetId: ownerPresetId
		});
		const [shortPreset] = await db
			.insert(intervalPresets)
			.values({ userId: ownerId, name: 'short', intervals: [1] })
			.returning();
		if (!shortPreset) throw new Error('fixture setup failed');
		// #82 以降 changeMemoPreset は reviews も同時に作り直すためこの不整合状態には
		// ならないが、#82 のデプロイ前の既存データでは起こり得るため、直接 UPDATE で再現する。
		await db.update(memos).set({ intervalPresetId: shortPreset.id }).where(eq(memos.id, memo.id));

		await makeAllReviewsDue(db, memo.id);
		const listed = await listDueReviews(db, ownerId);
		const due = listed.items[0];
		if (!due) throw new Error('fixture setup failed');

		const [step1Before] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)))
			.all();
		if (!step1Before) throw new Error('fixture setup failed');

		const detail = await getDueReviewDetail(db, ownerId, due.id);
		// reviews 側には元の3ステップ分の行が残っており、短縮後のプリセット
		// （intervals: [1]、length 1）とは異なる。ヘッダーの「全 m 回」は
		// 実際に画面遷移できるステップ数（3）と一致させる必要がある。
		expect(detail.totalSteps).toBe(3);
		// intervals[1] は存在しないため再アンカリング不可（nextReviewAt は undefined）。
		// completeReview と同じフォールバックで、既存の scheduledAt（step1Before）を返すべき。
		expect(detail.previewNextScheduledAt).not.toBeNull();
		expect(detail.previewNextScheduledAt?.getTime()).toBe(step1Before.scheduledAt.getTime());

		const result = await completeReview(db, ownerId, due.id);
		// completeReview が実際に返す nextScheduledAt（次のステップは残っている）と
		// プレビューが一致していること。
		expect(result.nextScheduledAt).not.toBeNull();
		expect(result.nextScheduledAt?.getTime()).toBe(detail.previewNextScheduledAt?.getTime());
	});

	// completeReview 側の同種テストと対になる検証。期限前の review は一覧に出ないだけでなく、
	// id を直接指定しても復習画面を開けない。
	it('rejects viewing the current step before its scheduledAt has arrived', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo',
			content: '本文',
			intervalPresetId: ownerPresetId
		});
		const [step0] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.all();
		if (!step0) throw new Error('fixture setup failed');

		await expect(getDueReviewDetail(db, ownerId, step0.id)).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError for an already-completed review', async () => {
		const { due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id);

		await expect(getDueReviewDetail(db, ownerId, due.id)).rejects.toThrow(NotFoundError);
	});

	it('throws NotFoundError for another user review', async () => {
		const { due } = await createOtherUserDueReview();
		await expect(getDueReviewDetail(db, ownerId, due.id)).rejects.toThrow(NotFoundError);
	});

	it('throws when the review does not exist', async () => {
		await expect(getDueReviewDetail(db, ownerId, crypto.randomUUID())).rejects.toThrow(
			NotFoundError
		);
	});

	it('throws NotFoundError for a review belonging to an archived memo', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await db.update(memos).set({ archivedAt: new Date() }).where(eq(memos.id, memo.id));

		await expect(getDueReviewDetail(db, ownerId, due.id)).rejects.toThrow(NotFoundError);
	});

	it('rejects viewing a later step while an earlier step is still incomplete', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		const step1 = rows.find((r) => r.step === 1);
		if (!step1) throw new Error('fixture setup failed');
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(Date.now() - 1000) })
			.where(eq(reviews.id, step1.id));

		await expect(getDueReviewDetail(db, ownerId, step1.id)).rejects.toThrow(ConflictError);
	});
});

// #18 の再計算レシピ（docs/schema.md の reviews 節、ユーザー承認済みの設計判断）。
// planReviewRecalculation 自体は文を組み立てるだけで実行しないため、各テストは
// db.batch() で実際に実行してから DB の状態を確認する（updateCustomPresetIntervals が
// 呼ぶのと同じ使い方）。
describe('planReviewRecalculation', () => {
	it('leaves completed rows byte-for-byte unchanged', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId); // intervals: [1, 24, 72]
		await completeReview(db, ownerId, due.id); // step0 完了

		const before = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.limit(1)
			.all();

		const plan = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		await commitReviewRecalculation(db, memo.id, plan);

		const after = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.limit(1)
			.all();
		expect(after).toEqual(before);
	});

	it('uses memo.createdAt as baseTime when no step has been completed yet', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const plan = await planReviewRecalculation(db, memo.id, [2, 5]);
		await commitReviewRecalculation(db, memo.id, plan);

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 2 * 60 * 60 * 1000);
		expect(rows[1]?.scheduledAt.getTime()).toBe(memo.createdAt.getTime() + 5 * 60 * 60 * 1000);
	});

	it('uses the latest completed step completedAt as baseTime once a step is completed', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		const completed = await completeReview(db, ownerId, due.id);

		const plan = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		await commitReviewRecalculation(db, memo.id, plan);

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		// step0 は完了済みのまま。step1・step2 は completedAt を起点に再計算される。
		expect(rows.map((r) => r.step)).toEqual([0, 1, 2]);
		const step1 = rows.find((r) => r.step === 1);
		const step2 = rows.find((r) => r.step === 2);
		expect(step1?.scheduledAt.getTime()).toBe(completed.completedAt.getTime() + 6 * 60 * 60 * 1000);
		expect(step2?.scheduledAt.getTime()).toBe(
			completed.completedAt.getTime() + 24 * 60 * 60 * 1000
		);
	});

	it('deletes and rebuilds due (already past) incomplete rows, not just future ones', async () => {
		// ユーザー承認済みの設計判断（due 行も含めて全て作り直す）。
		const { memo } = await createDueReview(ownerId, ownerPresetId);

		const plan = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		expect(plan.affectedCount).toBe(3); // 元の3ステップ全てが未完了・期限到来済み
		await commitReviewRecalculation(db, memo.id, plan);

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(rows).toHaveLength(3);
		// 新しい intervals から再生成されているため、もう期限切れではない。
		expect(rows.every((r) => r.scheduledAt.getTime() > Date.now())).toBe(true);
	});

	it('treats the memo as fully completed when the new intervals length is at or below the completed step count', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id); // step0 完了、step1・step2 は未完了

		// 新プリセットは1ステップのみ（既に完了済みの1ステップ以下）。
		const plan = await planReviewRecalculation(db, memo.id, [1]);
		await commitReviewRecalculation(db, memo.id, plan);

		const rows = await db.select().from(reviews).where(eq(reviews.memoId, memo.id)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.step).toBe(0);
		expect(rows[0]?.completedAt).not.toBeNull();
	});

	it('revives remaining steps if intervals are lengthened again after a shrink-to-zero', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		await completeReview(db, ownerId, due.id);

		const shrink = await planReviewRecalculation(db, memo.id, [1]);
		await commitReviewRecalculation(db, memo.id, shrink);

		const grow = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		await commitReviewRecalculation(db, memo.id, grow);

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(rows.map((r) => r.step)).toEqual([0, 1, 2]);
		expect(rows.filter((r) => r.completedAt === null)).toHaveLength(2);
	});

	// Issue #85 の回帰テスト（正確性レビューで指摘）: migrate 完了〜deploy 完了までの
	// 短い window（docs/design-decisions.md #7 節）に旧バージョンの createMemo で
	// 作られたメモは review_schedules 行を持たない。ここではそれを直接
	// db.delete() で再現し、治癒（ensureReviewScheduleExists）が働いて
	// 恒久的な失敗にならないことを確認する。
	it('heals a memo missing its review_schedules row (pre-#85 data) instead of failing forever', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo', // intervals: [1, 24, 72]
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await db.delete(reviewSchedules).where(eq(reviewSchedules.memoId, memo.id));

		const plan = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		expect(plan.expectedVersion).toBe(0);
		await commitReviewRecalculation(db, memo.id, plan);

		// 治癒された行に対して version=0 で claim が成立し、以後の再計算も
		// 通常どおり version=1 を前提に動作する（恒久的な ConflictError にならない）。
		const [healedRow] = await db
			.select({ version: reviewSchedules.version })
			.from(reviewSchedules)
			.where(eq(reviewSchedules.memoId, memo.id))
			.all();
		expect(healedRow?.version).toBe(1);

		const nextPlan = await planReviewRecalculation(db, memo.id, [2, 5]);
		expect(nextPlan.expectedVersion).toBe(1);
		await commitReviewRecalculation(db, memo.id, nextPlan);

		const rows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, memo.id))
			.orderBy(reviews.step)
			.all();
		expect(rows).toHaveLength(2);
	});
});

// #84: updateCustomPresetIntervals/previewPresetIntervalsUpdate 向けの一括取得。
// 「1メモにつき何回 SELECT するか」ではなく「対象メモ数に依らず一定回数で完了するか」
// を検証する。同じ入力から computeReviewRecalculation が作る結果が
// planReviewRecalculation（1メモずつ SELECT する既存経路）と一致することも合わせて
// 確認し、2つの経路が同じ計算ロジックを共有していることを保証する。
describe('loadReviewRecalculationInputs', () => {
	it('returns an empty map for an empty memoId list without querying', async () => {
		const inputs = await loadReviewRecalculationInputs(db, []);
		expect(inputs.size).toBe(0);
	});

	it('does not issue more SELECT queries as the memo count grows within a single chunk', async () => {
		// D1_MAX_BIND_PARAMS（100）のチャンク境界内であれば、対象メモ数に関わらず
		// 常に同じ回数の SELECT（3クエリ集合）で完了するはずで、1メモ増えるごとに
		// クエリが増えないことを示す（完了条件「クエリ数が対象メモ数に比例して
		// 増えない」の回帰テスト）。
		const memoIdsFor = async (count: number) => {
			const ids: string[] = [];
			for (let i = 0; i < count; i++) {
				const memo = await createMemo(db, ownerId, {
					title: `memo-${i}`,
					content: 'c',
					intervalPresetId: ownerPresetId
				});
				ids.push(memo.id);
			}
			return ids;
		};

		const fewIds = await memoIdsFor(5);
		const manyIds = await memoIdsFor(50);

		const selectSpy = vi.spyOn(db, 'select');
		selectSpy.mockClear();
		await loadReviewRecalculationInputs(db, fewIds);
		const callsForFew = selectSpy.mock.calls.length;

		selectSpy.mockClear();
		await loadReviewRecalculationInputs(db, manyIds);
		const callsForMany = selectSpy.mock.calls.length;

		selectSpy.mockRestore();
		expect(callsForMany).toBe(callsForFew);
	});

	it('splits into multiple chunked queries beyond the D1 bind parameter limit (100) without erroring', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 150; i++) {
			const memo = await createMemo(db, ownerId, {
				title: `memo-${i}`,
				content: 'c',
				intervalPresetId: ownerPresetId
			});
			ids.push(memo.id);
		}

		const inputs = await loadReviewRecalculationInputs(db, ids);
		expect(inputs.size).toBe(150);
		for (const id of ids) {
			expect(inputs.get(id)?.incompleteCount).toBe(3);
			expect(inputs.get(id)?.latestCompleted).toBeUndefined();
		}
	});

	it('matches planReviewRecalculation for a memo with zero completed steps', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'memo',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const single = await planReviewRecalculation(db, memo.id, [2, 5]);
		const inputs = await loadReviewRecalculationInputs(db, [memo.id]);
		const input = inputs.get(memo.id);
		if (!input) throw new Error('fixture setup failed');
		const batched = computeReviewRecalculation(memo.id, input, [2, 5]);

		expect(batched.affectedCount).toBe(single.affectedCount);
		expect(input.incompleteCount).toBe(3);
		expect(input.latestCompleted).toBeUndefined();
		expect(batched.newRows).toEqual([
			{ memoId: memo.id, step: 0, scheduledAt: nextReviewAt(memo.createdAt, [2, 5], 0) },
			{ memoId: memo.id, step: 1, scheduledAt: nextReviewAt(memo.createdAt, [2, 5], 1) }
		]);
	});

	it('matches planReviewRecalculation for a memo with a completed step (uses its completedAt as baseTime)', async () => {
		const { memo, due } = await createDueReview(ownerId, ownerPresetId);
		const completed = await completeReview(db, ownerId, due.id); // step0 完了

		const single = await planReviewRecalculation(db, memo.id, [1, 6, 24]);
		const inputs = await loadReviewRecalculationInputs(db, [memo.id]);
		const input = inputs.get(memo.id);
		if (!input) throw new Error('fixture setup failed');
		const batched = computeReviewRecalculation(memo.id, input, [1, 6, 24]);

		expect(input.latestCompleted).toEqual({ step: 0, completedAt: completed.completedAt });
		expect(input.incompleteCount).toBe(2); // step1・step2 のみ未完了
		expect(batched.affectedCount).toBe(single.affectedCount);
		expect(batched.newRows).toEqual([
			{ memoId: memo.id, step: 1, scheduledAt: nextReviewAt(completed.completedAt, [1, 6, 24], 1) },
			{ memoId: memo.id, step: 2, scheduledAt: nextReviewAt(completed.completedAt, [1, 6, 24], 2) }
		]);
	});

	it('keeps each memos completed rows separate when a completed-step memo and a zero-completed memo are fetched together', async () => {
		// completedRows を1つの配列にまとめてから memoId ごとに最大 step を振り分ける
		// latestCompletedMap の構築が、他のメモの completedAt を取り違えないことの
		// 回帰テスト（テスト網羅性レビューで指摘。単一メモずつの呼び出しでは
		// 「複数メモの完了済み行が1つの結果セットに混在した状態からの振り分け」を
		// 検証できていなかった）。
		const { memo: completedMemo, due } = await createDueReview(ownerId, ownerPresetId);
		const completed = await completeReview(db, ownerId, due.id); // step0 完了
		const freshMemo = await createMemo(db, ownerId, {
			title: 'fresh',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const inputs = await loadReviewRecalculationInputs(db, [completedMemo.id, freshMemo.id]);

		expect(inputs.get(completedMemo.id)?.latestCompleted).toEqual({
			step: 0,
			completedAt: completed.completedAt
		});
		expect(inputs.get(completedMemo.id)?.incompleteCount).toBe(2);
		expect(inputs.get(freshMemo.id)?.latestCompleted).toBeUndefined();
		expect(inputs.get(freshMemo.id)?.incompleteCount).toBe(3);
	});
});

describe('listReviewSchedule', () => {
	it('returns all steps ordered ascending, both completed and pending', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});

		const schedule = await listReviewSchedule(db, memo.id);
		expect(schedule.map((row) => row.step)).toEqual([0, 1, 2]);
		expect(schedule.every((row) => row.completedAt === null)).toBe(true);
	});

	it('distinguishes completed steps (with completedAt) from pending ones (without)', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		const [firstStep] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.all();
		if (!firstStep) throw new Error('fixture setup failed');
		const completedAt = new Date();
		await db.update(reviews).set({ completedAt }).where(eq(reviews.id, firstStep.id));

		const schedule = await listReviewSchedule(db, memo.id);
		expect(schedule[0]?.completedAt?.getTime()).toBe(completedAt.getTime());
		expect(schedule[1]?.completedAt).toBeNull();
	});

	it('returns an empty array for a memo with no reviews', async () => {
		const schedule = await listReviewSchedule(db, crypto.randomUUID());
		expect(schedule).toEqual([]);
	});

	it('reports every step as completed once all steps are done', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.memoId, memo.id));

		const schedule = await listReviewSchedule(db, memo.id);
		expect(schedule).toHaveLength(3);
		expect(schedule.every((row) => row.completedAt !== null)).toBe(true);
	});
});

describe('getCurrentPendingReview', () => {
	it('returns the smallest incomplete step', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		const [firstStep] = await db
			.select()
			.from(reviews)
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)))
			.all();
		if (!firstStep) throw new Error('fixture setup failed');
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.id, firstStep.id));

		const current = await getCurrentPendingReview(db, memo.id);
		expect(current?.step).toBe(1);
	});

	it('returns undefined once every step is completed', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		await db.update(reviews).set({ completedAt: new Date() }).where(eq(reviews.memoId, memo.id));

		const current = await getCurrentPendingReview(db, memo.id);
		expect(current).toBeUndefined();
	});

	// #82 のデプロイより前に古い updateMemo でプリセットだけが変更され、reviews が
	// 作り直されていない既存メモを模す: step 0（未完了）の scheduledAt が、
	// 本来より後の step 1（同じく未完了）の scheduledAt より「遅い」。
	// min(scheduledAt) で選ぶ実装だと step 1 を誤って「現在の未完了 step」として
	// 返してしまう（#83 が解消する不整合）。min(step) 相当の判定なら、常に
	// scheduledAt の大小に関係なく step 0 を返す。
	it('picks the smallest step even when a later pending step has an earlier scheduledAt', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'title',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		const now = new Date();
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() + 10_000) })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 0)));
		await db
			.update(reviews)
			.set({ scheduledAt: new Date(now.getTime() - 10_000) })
			.where(and(eq(reviews.memoId, memo.id), eq(reviews.step, 1)));

		const current = await getCurrentPendingReview(db, memo.id);
		expect(current?.step).toBe(0);
	});
});
