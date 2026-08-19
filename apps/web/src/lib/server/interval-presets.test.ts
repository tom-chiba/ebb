import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, eq, intervalPresets, reviews, reviewSchedules, userSettings, type Db } from '@ebb/db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import {
	createCustomPreset,
	deleteCustomPreset,
	DEFAULT_INTERVAL_PRESET_ID,
	getDefaultPresetId,
	getPresetNameAndIntervals,
	listMemosUsingPreset,
	listPresetsForUser,
	MAX_BATCH_STATEMENTS,
	PRESET_NAME_MAX_LENGTH,
	previewPresetIntervalsUpdate,
	setDefaultPresetForUser,
	updateCustomPresetIntervals
} from './interval-presets';
import { archiveMemo, createMemo } from './memos';
import { completeReview } from './reviews';
import * as reviewsModule from './reviews';
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

describe('getPresetNameAndIntervals', () => {
	it('returns the name and intervals for an existing preset', async () => {
		const result = await getPresetNameAndIntervals(db, ownerPresetId);
		expect(result).toEqual({ name: 'owner preset', intervals: [1, 24, 72] });
	});

	it('returns undefined for a non-existent preset id', async () => {
		const result = await getPresetNameAndIntervals(db, crypto.randomUUID());
		expect(result).toBeUndefined();
	});
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

	it('does not leak another users usage of a shared system preset via inUse', async () => {
		// システム標準プリセットは全ユーザー共有のため、inUse を userId で絞らずに
		// 計算すると「自分が使っているか」ではなく「他ユーザーも含め誰かが使っているか」
		// になってしまう（正確性レビューで指摘）。
		await createMemo(db, otherUserId, {
			title: 'other users memo',
			content: 'c',
			intervalPresetId: systemPresetId
		});

		const presets = await listPresetsForUser(db, ownerId);
		expect(presets.find((p) => p.id === systemPresetId)?.inUse).toBe(false);
	});

	it('counts the number of memos (including archived) referencing the preset', async () => {
		const before = await listPresetsForUser(db, ownerId);
		expect(before.find((p) => p.id === ownerPresetId)?.inUseCount).toBe(0);

		const memoA = await createMemo(db, ownerId, {
			title: 'a',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await createMemo(db, ownerId, { title: 'b', content: 'c', intervalPresetId: ownerPresetId });
		const afterCreate = await listPresetsForUser(db, ownerId);
		expect(afterCreate.find((p) => p.id === ownerPresetId)?.inUseCount).toBe(2);

		await archiveMemo(db, ownerId, memoA.id);
		const afterArchive = await listPresetsForUser(db, ownerId);
		// アーカイブ済みでも FK は残っているため件数は変わらない（inUse と同じ集計）。
		expect(afterArchive.find((p) => p.id === ownerPresetId)?.inUseCount).toBe(2);
	});

	it('does not leak another users usage count of a shared system preset', async () => {
		await createMemo(db, otherUserId, {
			title: 'other users memo',
			content: 'c',
			intervalPresetId: systemPresetId
		});

		const presets = await listPresetsForUser(db, ownerId);
		expect(presets.find((p) => p.id === systemPresetId)?.inUseCount).toBe(0);
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

	it(`rejects a name longer than ${PRESET_NAME_MAX_LENGTH} characters`, async () => {
		const tooLong = 'a'.repeat(PRESET_NAME_MAX_LENGTH + 1);
		await expect(createCustomPreset(db, ownerId, tooLong, '1h')).rejects.toThrow(ValidationError);
	});

	it(`accepts a name exactly ${PRESET_NAME_MAX_LENGTH} characters long`, async () => {
		const exactly = 'a'.repeat(PRESET_NAME_MAX_LENGTH);
		const preset = await createCustomPreset(db, ownerId, exactly, '1h');
		expect(preset.name).toBe(exactly);
	});
});

// previewPresetIntervalsUpdate は updateCustomPresetIntervals（確定側）と全く同じ
// 所有権チェック・構文検証を通る必要がある。片方だけ検証を通す実装に戻すと、
// confirmed=false のプレビュー経路だけが認可・検証を素通りし、他ユーザーの
// custom プリセットやシステムプリセットの id を渡すことでそのプリセットを使っている
// （自分のものではない）メモの未完了 reviews 件数を取得できてしまう
// （正確性レビューで指摘された情報漏洩の回帰テスト）。
describe('previewPresetIntervalsUpdate', () => {
	it('rejects previewing a system preset without leaking its usage count', async () => {
		await expect(previewPresetIntervalsUpdate(db, ownerId, systemPresetId, '1h')).rejects.toThrow(
			ValidationError
		);
	});

	it('rejects previewing another users custom preset without revealing it exists', async () => {
		await expect(
			previewPresetIntervalsUpdate(db, ownerId, otherUserPresetId, '1h')
		).rejects.toThrow(NotFoundError);
	});

	it('rejects a nonexistent presetId', async () => {
		await expect(previewPresetIntervalsUpdate(db, ownerId, 'does-not-exist', '1h')).rejects.toThrow(
			NotFoundError
		);
	});

	it('rejects invalid intervals before showing any preview count', async () => {
		await expect(
			previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '2h, 1h')
		).rejects.toThrow(ValidationError);
	});

	it('returns the same count that updateCustomPresetIntervals later reports as updated', async () => {
		await createMemo(db, ownerId, { title: 'a', content: 'c', intervalPresetId: ownerPresetId });
		await createMemo(db, ownerId, { title: 'b', content: 'c', intervalPresetId: ownerPresetId });

		const { previewCount } = await previewPresetIntervalsUpdate(
			db,
			ownerId,
			ownerPresetId,
			'2h, 5h'
		);
		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'2h, 5h'
		);
		expect(previewCount).toBe(6); // 2メモ × 3ステップ
		expect(updatedReviewsCount).toBe(previewCount);
	});

	it('returns zero when the preset is not yet used by any memo', async () => {
		const { previewCount } = await previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '2h');
		expect(previewCount).toBe(0);
	});

	it('#63: intervals の変更前後の差分を返す（owner preset の元の intervals は [1, 24, 72]）', async () => {
		const { diff } = await previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '2h, 4d, 6d');
		expect(diff).toEqual([
			{ oldHours: 1, newHours: 2, status: 'changed' },
			{ oldHours: 24, newHours: 96, status: 'changed' },
			{ oldHours: 72, newHours: 144, status: 'changed' }
		]);
	});

	it('#63: 途中のステップを削除した場合、以降の共通ステップは changed にならない', async () => {
		const { diff } = await previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '1h, 3d');
		expect(diff).toEqual([
			{ oldHours: 1, newHours: 1, status: 'unchanged' },
			{ oldHours: 24, newHours: undefined, status: 'removed' },
			{ oldHours: 72, newHours: 72, status: 'unchanged' }
		]);
	});

	it('rejects the preview when the update would exceed MAX_BATCH_STATEMENTS, before it ever succeeds', async () => {
		// 実行系（updateCustomPresetIntervals）と同じメモ数を使い、プレビューが
		// 「N件の予定が更新されます」と成功を返した直後に確定操作だけが拒否される
		// 非対称（正確性レビューで指摘）が起きないことを確認する。
		const memoCount = Math.ceil(MAX_BATCH_STATEMENTS / 2) + 1;
		for (let i = 0; i < memoCount; i++) {
			await createMemo(db, ownerId, {
				title: `memo-${i}`,
				content: 'c',
				intervalPresetId: ownerPresetId
			});
		}

		await expect(
			previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '1h, 2h')
		).rejects.toThrow(ValidationError);
	});

	it('counts correctly across D1s per-query bind parameter limit (100) without erroring', async () => {
		// D1 は1クエリあたりの bind パラメータ数に上限があり（ローカル実測でちょうど100件、
		// 101件から `too many SQL variables` になる）、loadReviewRecalculationInputs
		// （$lib/server/reviews.ts、#84 で一括取得に変更）が memoId をチャンク分割せずに
		// inArray へまとめて渡すと、MAX_BATCH_STATEMENTS（500）が許容する規模
		// （悲観的見積もりで最大250メモ）の範囲内でも生の D1 エラーになりうる
		// （#18 の正確性レビューで指摘、実測で確認した回帰）。ここでは
		// MAX_BATCH_STATEMENTS には抵触しないが100件は超えるメモ数で実行し、
		// チャンク分割が正しく機能して例外を投げないことを確認する。
		const memoCount = 150;
		for (let i = 0; i < memoCount; i++) {
			await createMemo(db, ownerId, {
				title: `memo-${i}`,
				content: 'c',
				intervalPresetId: ownerPresetId
			});
		}

		const { previewCount } = await previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '2h');
		expect(previewCount).toBe(memoCount * 3);
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

		const { previewCount } = await previewPresetIntervalsUpdate(db, ownerId, ownerPresetId, '2h');
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

	it('succeeds with zero updated reviews when the preset is not yet used by any memo', async () => {
		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'2h'
		);
		expect(updatedReviewsCount).toBe(0);
		const [preset] = await db
			.select()
			.from(intervalPresets)
			.where(eq(intervalPresets.id, ownerPresetId))
			.all();
		expect(preset?.intervals).toEqual([2]);
	});

	it(
		'succeeds just under the pessimistic worst-case batch statement limit',
		{ timeout: 10_000 },
		async () => {
			// updateCustomPresetIntervals も（プレビューとの非対称防止のため）
			// estimateWorstCaseBatchStatementCount による悲観的見積もりで早期リジェクトする
			// ようになった（設計レビューで指摘。以前は実測の statements.length のみで
			// 判定しており、大量メモに対する確定操作が高コストな処理を全て実行してから
			// 拒否していた）。この見積もりは batch A（claim の DELETE + version bump、
			// 1メモあたり最大2文）が律速するという前提のため、実際の文数によらず
			// memoCount 単体で「memoCount*2 <= 500」となる250メモまでは必ず成功する。
			const memoCount = Math.floor(MAX_BATCH_STATEMENTS / 2);
			for (let i = 0; i < memoCount; i++) {
				await createMemo(db, ownerId, {
					title: `memo-${i}`,
					content: 'c',
					intervalPresetId: ownerPresetId
				});
			}

			const { updatedReviewsCount } = await updateCustomPresetIntervals(
				db,
				ownerId,
				ownerPresetId,
				'1h, 2h'
			);
			expect(updatedReviewsCount).toBe(memoCount * 3);
		}
	);

	it(
		'rejects the update before doing any per-memo work when the pessimistic estimate alone exceeds the limit',
		{ timeout: 10_000 },
		async () => {
			// previewPresetIntervalsUpdate と同じ悲観的見積もりを実行系の入口でも使う
			// ようになったため、対象メモ数だけで即座にリジェクトされ、実際の統計文数
			// （completedCount 次第でもっと少ない可能性がある）には依存しない。
			const memoCount = Math.ceil(MAX_BATCH_STATEMENTS / 2) + 1;
			for (let i = 0; i < memoCount; i++) {
				await createMemo(db, ownerId, {
					title: `memo-${i}`,
					content: 'c',
					intervalPresetId: ownerPresetId
				});
			}

			await expect(updateCustomPresetIntervals(db, ownerId, ownerPresetId, '1h')).rejects.toThrow(
				ValidationError
			);
			const [preset] = await db
				.select()
				.from(intervalPresets)
				.where(eq(intervalPresets.id, ownerPresetId))
				.all();
			expect(preset?.intervals).toEqual([1, 24, 72]);
		}
	);

	// planReviewRecalculation の SELECT（完了済みステップ数・未完了行の読み取り）と
	// この db.batch() 実行の間に、別リクエストの completeReview が同じメモの対象
	// ステップを完了させる真の競合を再現する（#17 の completeReview 自身が同種の
	// ハザードに対し wonThisCompletion ガードで対処しているのと同じ根本原因。
	// 正確性レビューで指摘）。db.batch を1回だけ横取りし、実際の batch 実行前に
	// completeReview を割り込ませることで、古い completedCount を前提にした INSERT が
	// 既に完了済みの step 番号と衝突する状況を決定的に再現する。
	it('translates a concurrent completion race into a ConflictError instead of a raw DB error', async () => {
		const memo = await createMemo(db, ownerId, {
			title: 'm', // ownerPreset の intervals: [1, 24, 72]
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
				// updateCustomPresetIntervals の SELECT はこの時点で完了しており
				// completedCount=0 を前提に step0 から INSERT しようとしている。
				// ここで step0 を完了させることで、その前提を古くする。
				await completeReview(db, ownerId, due.id);
				return originalBatch(queries);
			});

		try {
			await expect(
				updateCustomPresetIntervals(db, ownerId, ownerPresetId, '2h, 5h')
			).rejects.toThrow(ConflictError);
		} finally {
			batchSpy.mockRestore();
		}

		// この memo は claim（batch A）に負けたため reviews は再計算されないが、
		// プリセット自体の UPDATE は batch B で常に実行されるため反映される
		// （batch A 直後に中断すると、他に勝った memo がいた場合その reviews を
		// 永久に失うため。advisor 指摘・実機で再現し修正）。ユーザーは 409 を
		// 受けてこの memo だけ retry すればよい。
		const [preset] = await db
			.select()
			.from(intervalPresets)
			.where(eq(intervalPresets.id, ownerPresetId))
			.all();
		expect(preset?.intervals).toEqual([2, 5]);
	});

	// claim（batch A: DELETE + version bump）に勝った memo の reviews は batch A の
	// 時点で既に削除・確定されている。そのため、同じ操作の中で別の memo が claim に
	// 負けて全体が ConflictError になる場合でも、勝った memo の reviews が
	// batch B（プリセット UPDATE + INSERT）で必ず INSERT されることを確認する
	// 回帰テスト（advisor 指摘・実機で再現した「winner の未完了 reviews が
	// 永久に失われる」不具合の修正確認）。
	it(
		'still recreates a winning memo reviews and updates the preset even when a losing memo forces a 409',
		async () => {
			const winner = await createMemo(db, ownerId, {
				title: 'winner', // ownerPreset の intervals: [1, 24, 72]
				content: 'c',
				intervalPresetId: ownerPresetId
			});
			const loser = await createMemo(db, ownerId, {
				title: 'loser',
				content: 'c',
				intervalPresetId: ownerPresetId
			});
			const [loserDue] = await db
				.select({ id: reviews.id })
				.from(reviews)
				.where(eq(reviews.memoId, loser.id))
				.orderBy(reviews.step)
				.limit(1)
				.all();
			if (!loserDue) throw new Error('fixture setup failed');
			await db
				.update(reviews)
				.set({ scheduledAt: new Date(Date.now() - 1000) })
				.where(eq(reviews.id, loserDue.id));

			const originalBatch = db.batch.bind(db);
			const batchSpy = vi
				.spyOn(db, 'batch')
				.mockImplementationOnce(async (queries: Parameters<typeof originalBatch>[0]) => {
					// updateCustomPresetIntervals の SELECT 完了後・claim batch 実行前に
					// loser だけ completeReview で version を進めて古くする。winner の
					// version には触れない。
					await completeReview(db, ownerId, loserDue.id);
					return originalBatch(queries);
				});

			try {
				await expect(
					updateCustomPresetIntervals(db, ownerId, ownerPresetId, '2h, 5h')
				).rejects.toThrow(ConflictError);
			} finally {
				batchSpy.mockRestore();
			}

			// winner の未完了 reviews は失われず、新しい intervals で再作成されている。
			const winnerRows = await db
				.select()
				.from(reviews)
				.where(eq(reviews.memoId, winner.id))
				.all();
			expect(winnerRows.filter((row) => row.completedAt === null)).toHaveLength(2);

			// プリセット自体も更新されている（batch B は常に実行されるため）。
			const [preset] = await db
				.select()
				.from(intervalPresets)
				.where(eq(intervalPresets.id, ownerPresetId))
				.all();
			expect(preset?.intervals).toEqual([2, 5]);
		}
	);

	// collectAffectedMemoIds が対象メモを列挙した後、db.batch() 確定前にもう一度
	// アーカイブ状態を確認する stillActiveMemoIds ガード（正確性レビューで指摘）の
	// 回帰テスト。db.batch を横取りする既存の競合テストとは異なるタイミング
	// （「対象メモの列挙後・再確認前」）を再現する必要があるため、代わりに
	// loadReviewRecalculationInputs（#84 で対象メモ全件を一括取得するようになった、
	// updateCustomPresetIntervals 内で1回だけ呼ばれる関数）を横取りし、その内部で
	// 該当メモを archiveMemo することで、再確認より前にアーカイブが割り込む状況を
	// 決定的に再現する。
	it('excludes a memo archived after it was selected but before the batch commits', async () => {
		const staysActive = await createMemo(db, ownerId, {
			title: 'stays-active',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const getsArchivedMidFlight = await createMemo(db, ownerId, {
			title: 'archived-mid-flight',
			content: 'c',
			intervalPresetId: ownerPresetId
		});

		const originalLoad = reviewsModule.loadReviewRecalculationInputs;
		const loadSpy = vi
			.spyOn(reviewsModule, 'loadReviewRecalculationInputs')
			.mockImplementation(async (db2, memoIds) => {
				await archiveMemo(db2, ownerId, getsArchivedMidFlight.id);
				return originalLoad(db2, memoIds);
			});

		try {
			const { updatedReviewsCount } = await updateCustomPresetIntervals(
				db,
				ownerId,
				ownerPresetId,
				'2h, 5h'
			);
			// staysActive の元3ステップ分のみ。途中でアーカイブされたメモの分は含まない。
			expect(updatedReviewsCount).toBe(3);
		} finally {
			loadSpy.mockRestore();
		}

		const activeRows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, staysActive.id))
			.orderBy(reviews.step)
			.all();
		expect(activeRows).toHaveLength(2);

		// archiveMemo が削除した未完了行のまま。stillActiveMemoIds ガードが機能して
		// いなければ、ここに新しい未完了行が2件 INSERT されてしまう。
		const archivedRows = await db
			.select()
			.from(reviews)
			.where(eq(reviews.memoId, getsArchivedMidFlight.id))
			.all();
		expect(archivedRows).toHaveLength(0);
	});

	// Issue #85 の回帰テスト（正確性レビューで指摘）: migrate〜deploy window の
	// 既存データを想定し、対象メモの一部が review_schedules 行を持たない状態でも、
	// 一括更新（bulk 経路）が恒久的に失敗せず治癒して成功することを確認する。
	it('heals memos missing their review_schedules row (pre-#85 data) instead of excluding them forever', async () => {
		const withSchedule = await createMemo(db, ownerId, {
			title: 'with-schedule',
			content: 'c',
			intervalPresetId: ownerPresetId // intervals: [1, 24, 72]
		});
		const missingSchedule = await createMemo(db, ownerId, {
			title: 'missing-schedule',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await db.delete(reviewSchedules).where(eq(reviewSchedules.memoId, missingSchedule.id));

		const { updatedReviewsCount } = await updateCustomPresetIntervals(
			db,
			ownerId,
			ownerPresetId,
			'2h, 5h'
		);
		// 両メモとも元の3ステップ全てが未完了だったため合計6件。
		expect(updatedReviewsCount).toBe(6);

		for (const memo of [withSchedule, missingSchedule]) {
			const rows = await db
				.select()
				.from(reviews)
				.where(eq(reviews.memoId, memo.id))
				.orderBy(reviews.step)
				.all();
			expect(rows).toHaveLength(2);
		}

		const [healedRow] = await db
			.select({ version: reviewSchedules.version })
			.from(reviewSchedules)
			.where(eq(reviewSchedules.memoId, missingSchedule.id))
			.all();
		expect(healedRow?.version).toBe(1);
	});
});

describe('listMemosUsingPreset', () => {
	it('returns the id/title of memos referencing the preset, including archived ones', async () => {
		const active = await createMemo(db, ownerId, {
			title: 'active memo',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		const archived = await createMemo(db, ownerId, {
			title: 'archived memo',
			content: 'c',
			intervalPresetId: ownerPresetId
		});
		await archiveMemo(db, ownerId, archived.id);

		const result = await listMemosUsingPreset(db, ownerPresetId);
		expect(result.map((memo) => memo.id).sort()).toEqual([active.id, archived.id].sort());
		expect(result.find((memo) => memo.id === active.id)?.title).toBe('active memo');
	});

	it('returns an empty array when no memo references the preset', async () => {
		expect(await listMemosUsingPreset(db, ownerPresetId)).toEqual([]);
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

	it('rejects deleting a nonexistent presetId', async () => {
		await expect(deleteCustomPreset(db, ownerId, 'does-not-exist')).rejects.toThrow(NotFoundError);
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
