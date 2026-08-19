import {
	and,
	count,
	eq,
	exists,
	gt,
	isNull,
	lte,
	memos,
	reviews,
	reviewSchedules,
	sql,
	type BatchItem,
	type Db
} from '@ebb/db';
import { nextReviewAt } from '@ebb/core';
import { ConflictError, NotFoundError } from '../errors';
// presets/index.ts（update-preset-intervals.ts）が '../reviews'（このディレクトリの
// index.ts）に依存しているため、そちら経由で import すると循環になる。getPresetIntervals
// は presets 側の DB アクセスのみの葉モジュール（queries.ts）にあるため、バレルを
// 経由せず直接 import して循環を避ける。
import { getPresetIntervals } from '../interval-presets/queries';
import {
	assertIsCurrentStep,
	resolveNextScheduledAt,
	reviewScheduleVersionMatches
} from './policy';
import { ensureReviewScheduleExists } from './schedule-recalculation';

export interface DueReviewDetail {
	id: string;
	memoId: string;
	memoTitle: string;
	step: number;
	// このメモの reviews 行の総数（完了済み + 未完了、「n 回目 / 全 m 回」表示用）。
	// intervalPresets.intervals.length ではなくこちらを正とする理由は totalSteps の
	// 計算箇所（getDueReviewDetail）のコメントを参照。
	totalSteps: number;
	scheduledAt: Date;
	memoContent: string;
	// 今この場で完了した場合に次のステップが再アンカリングされる予定時刻の事前計算。
	// completeReview と同じ nextReviewAt(baseTime, intervals, step) を使うため、実際に
	// 完了した際の値と（完了操作までの経過時間による分単位のずれを除き）一致する。
	// 次のステップが存在しない（このステップが最終ステップ）場合は null。
	previewNextScheduledAt: Date | null;
}

export interface CompletedReview {
	id: string;
	memoId: string;
	memoTitle: string;
	completedAt: Date;
	// このメモの残り未完了ステップが無くなった（全ステップ完了した）場合は null。
	nextScheduledAt: Date | null;
}

export async function getDueReviewDetail(
	db: Db,
	userId: string,
	id: string
): Promise<DueReviewDetail> {
	const now = new Date();
	const rows = await db
		.select({
			id: reviews.id,
			memoId: reviews.memoId,
			memoTitle: memos.title,
			memoContent: memos.content,
			step: reviews.step,
			scheduledAt: reviews.scheduledAt,
			completedAt: reviews.completedAt,
			intervalPresetId: memos.intervalPresetId
		})
		.from(reviews)
		.innerJoin(memos, eq(reviews.memoId, memos.id))
		.where(
			and(
				eq(reviews.id, id),
				eq(memos.userId, userId),
				isNull(memos.archivedAt),
				lte(reviews.scheduledAt, now)
			)
		)
		.limit(1)
		.all();
	const row = rows[0];
	if (!row || row.completedAt !== null) throw new NotFoundError('review not found');

	await assertIsCurrentStep(db, row.memoId, row.step);

	const intervals = await getPresetIntervals(db, row.intervalPresetId);

	// 「全 m 回」は現在のプリセットの intervals ではなく、このメモの reviews 行の総数
	// （完了済み + 未完了）で数える。#82 以降 changeMemoPreset は intervalPresetId の
	// 変更と reviews の作り直しを同じ db.batch() で行うため通常は一致するが、#82 の
	// デプロイより前に古い updateMemo でプリセットだけが変更され reviews が
	// 作り直されていない既存メモでは、intervals.length と実際の reviews 行数が
	// ずれ得る（completeReview 節の既存コメントと同じ前提）。ヘッダーの
	// 「n 回目 / 全 m 回」は実際に画面遷移できるステップ数と一致させる必要があるため、
	// reviews 側の実数を正とする。
	const totalRows = await db
		.select({ total: count() })
		.from(reviews)
		.where(eq(reviews.memoId, row.memoId))
		.all();
	// count() は必ず1行返すため totalRows[0] は必ず存在するが、listDueReviews と同じ
	// 慣習で `?? 0` にする（設計レビューで指摘: 以前は `?? intervals.length` だった。
	// これは到達しないコードである上、直前のコメントが「reviews 側の実数を正とする」と
	// 述べているのに intervals 側の値へフォールバックしており矛盾していた）。
	const totalSteps = totalRows[0]?.total ?? 0;

	// 次のステップの reviews 行が実在するかを見て「次回予定」の有無を判定する
	// （intervals.length だけを見ると、プリセット変更後に「次のステップが無い」と
	// 誤判定し、実際に「復習した」を押した際の completeReview の結果と矛盾する
	// 表示になってしまう。正確性レビューで指摘。見つかった行から返す日時の決定は
	// resolveNextScheduledAt として completeReview と共有している）。
	const nextStep = row.step + 1;
	const nextStepRows = await db
		.select({ scheduledAt: reviews.scheduledAt })
		.from(reviews)
		.where(
			and(eq(reviews.memoId, row.memoId), eq(reviews.step, nextStep), isNull(reviews.completedAt))
		)
		.limit(1)
		.all();
	const previewNextScheduledAt = resolveNextScheduledAt(
		nextStepRows[0],
		nextReviewAt(now, intervals, nextStep)
	);

	return {
		id: row.id,
		memoId: row.memoId,
		memoTitle: row.memoTitle,
		memoContent: row.memoContent,
		step: row.step,
		totalSteps,
		scheduledAt: row.scheduledAt,
		previewNextScheduledAt
	};
}

export async function completeReview(db: Db, userId: string, id: string): Promise<CompletedReview> {
	const requestedAt = new Date();
	// reviews 自体は userId を持たないため、所有権の確認は memos との JOIN で行う。
	// scheduleVersion は Issue #85 の楽観ロック用（下記 wonThisCompletion・
	// scheduleVersionMatches の説明を参照）。review_schedules 行が無いメモを
	// 対象から除外しないよう leftJoin にする（ensureReviewScheduleExists 参照）。
	const rows = await db
		.select({
			id: reviews.id,
			memoId: reviews.memoId,
			memoTitle: memos.title,
			step: reviews.step,
			completedAt: reviews.completedAt,
			intervalPresetId: memos.intervalPresetId,
			scheduleVersion: reviewSchedules.version
		})
		.from(reviews)
		.innerJoin(memos, eq(reviews.memoId, memos.id))
		.leftJoin(reviewSchedules, eq(reviewSchedules.memoId, memos.id))
		.where(
			and(
				eq(reviews.id, id),
				eq(memos.userId, userId),
				isNull(memos.archivedAt),
				lte(reviews.scheduledAt, requestedAt)
			)
		)
		.limit(1)
		.all();
	const target = rows[0];
	if (!target) throw new NotFoundError('review not found');
	if (target.completedAt !== null) throw new ConflictError('review has already been completed');

	if (target.scheduleVersion === null) {
		await ensureReviewScheduleExists(db, target.memoId);
	}
	const scheduleVersion = target.scheduleVersion ?? 0;

	await assertIsCurrentStep(db, target.memoId, target.step);

	// 完了時刻を起点に、このメモの残り未完了ステップの scheduledAt を再計算する
	// （ユーザー承認済みの設計判断、docs/design-decisions.md の #17 節）。放置していた
	// 期間をそのまま引き継いで一括消化できてしまうことを避け、間隔反復として機能させる。
	const intervals = await getPresetIntervals(db, target.intervalPresetId);

	const remaining = await db
		.select({ id: reviews.id, step: reviews.step, scheduledAt: reviews.scheduledAt })
		.from(reviews)
		.where(
			and(
				eq(reviews.memoId, target.memoId),
				isNull(reviews.completedAt),
				gt(reviews.step, target.step)
			)
		)
		.all();

	const completedAt = new Date();

	// この completeReview 呼び出し自身が対象ステップを completedAt で完了させたことを
	// 保証するガード。db.batch 内の先頭 UPDATE（completeCurrent）が競合により0件更新に
	// なっても、後続の UPDATE 文はエラーにならず実行されてしまう（D1 の batch は文の
	// 成否ではなく件数不一致を検出しない）。このガードなしだと、同時に2件の完了操作が
	// 走った際、負けた側（completedAt がこの呼び出しの値ではない）のバッチでも残り
	// ステップの再アンカリングだけが自分の completedAt を起点に成功してしまい、
	// 保存された completedAt と再アンカリング元の時刻が食い違う（Codex のレビューで指摘）。
	const wonThisCompletion = exists(
		db
			.select({ one: sql`1` })
			.from(reviews)
			.where(and(eq(reviews.id, id), eq(reviews.completedAt, completedAt)))
	);

	// Issue #85: reviews への書き込み経路は、同じ論理操作内で review_schedules.version
	// の CAS に勝った場合のみ書き込む、という不変条件を completeReview 自身にも課す。
	// scheduleVersionMatches が false になるのは、この呼び出しの SELECT（冒頭の
	// scheduleVersion 取得）より後に、別リクエストの changeMemoPreset・
	// updateCustomPresetIntervals（いずれも claim 成功時に version をこの条件と
	// 同じ形で更新する、下記 reviewScheduleVersionMatches を参照）が割り込んだ場合。
	// completeCurrent の WHERE に含めることで、古いスナップショット（旧 intervals・
	// 旧 step 構成）を前提にした完了・再アンカリングがコミットされることを防ぐ。
	const scheduleVersionMatches = reviewScheduleVersionMatches(db, target.memoId, scheduleVersion);

	// #82 以降 changeMemoPreset は intervalPresetId の変更と reviews の作り直しを
	// 同じ db.batch() で行うため、通常この reviews のステップ数は現在のプリセットの
	// intervals と整合している。しかし #82 のデプロイより前に古い updateMemo で
	// プリセットだけが変更され reviews が作り直されていない既存メモでは、現在の
	// プリセットの intervals が当時より短くなっていることがあり、残りステップの
	// 一部・全部を再計算できない（nextReviewAt が undefined を返す）場合がある。
	// そのステップの再アンカリングだけをスキップする（scheduledAt は変更前の値の
	// まま残る）。この既存メモの不整合自体をここで解消することはしないが、
	// 「対象ステップの完了」をこの不整合を理由に失敗させない。
	const reanchorUpdates = remaining
		.map((row) => {
			const scheduledAt = nextReviewAt(completedAt, intervals, row.step);
			if (!scheduledAt) return null;
			return {
				query: db
					.update(reviews)
					.set({ scheduledAt, notifiedAt: null, notificationAttemptedAt: null })
					.where(and(eq(reviews.id, row.id), isNull(reviews.completedAt), wonThisCompletion)),
				step: row.step,
				scheduledAt
			};
		})
		.filter((update) => update !== null);

	const completeCurrent = db
		.update(reviews)
		.set({ completedAt })
		// SELECT 後に #18 の再計算等で期限が未来へ移された場合も、古い画面や通知から
		// 期限前に完了できないよう UPDATE 自体でも due 条件を再検証する。scheduleVersionMatches
		// により、#85 の claim（changeMemoPreset・updateCustomPresetIntervals）が
		// この SELECT より後に割り込んだ場合も同じ 0 行ヒットで検出する。
		.where(
			and(
				eq(reviews.id, id),
				isNull(reviews.completedAt),
				lte(reviews.scheduledAt, completedAt),
				scheduleVersionMatches
			)
		)
		.returning();

	// この呼び出し自身の完了・再アンカリングが確定したことを、後続の claim（#85）が
	// 検出できるようにする。wonThisCompletion で「この呼び出しが実際に勝った場合のみ」
	// に絞るのは reanchorUpdates と同じ理由（Codex のレビューで指摘された既存の
	// ガードと同型）。
	const bumpScheduleVersion = db
		.update(reviewSchedules)
		.set({ version: sql`${reviewSchedules.version} + 1` })
		.where(and(eq(reviewSchedules.memoId, target.memoId), wonThisCompletion));

	// db.batch は静的に1件以上とわかるタプル型（BatchItem<'sqlite'> の非空配列）を
	// 要求するが、再アンカリング対象の件数は実行時にしか決まらない。completeCurrent が
	// 常に配列先頭にあるため実行時には常に1件以上になるが、可変長の spread を含む配列
	// リテラルが非空タプルであることは TypeScript の型システムでは静的に証明できない
	// ため、型注釈で表明する（db.batch の結果は先頭要素の completedRows のみ参照する）。
	const batchQueries: [typeof completeCurrent, ...BatchItem<'sqlite'>[]] = [
		completeCurrent,
		...reanchorUpdates.map((u) => u.query),
		bumpScheduleVersion
	];
	const [completedRows] = await db.batch(batchQueries);
	if (!completedRows[0]) {
		// 直前の存在確認と実際の UPDATE の間に、別リクエストが先に完了させたか、
		// #85 の claim が割り込んだ場合。
		throw new ConflictError('review has already been completed');
	}

	// nextScheduledAt は「このメモの復習が全ステップ完了した」（null）と「次のステップは
	// 存在するが、プリセット短縮により再アンカリングできず古い scheduledAt のまま残って
	// いる」を区別する必要がある。後者を再アンカリング結果（reanchorUpdates、undefined
	// を返したステップは除外済み）だけから判定すると、両者とも見つからず null になり、
	// 実際には未完了ステップが残っているのに「すべて完了しました」と表示されてしまう
	// （正確性レビューで指摘）。フィルタ前の remaining で「次のステップの行自体が
	// 存在するか」を見た上で判定する（resolveNextScheduledAt、getDueReviewDetail の
	// プレビュー計算と共有するロジック）。
	const nextStep = target.step + 1;
	const nextRow = remaining.find((row) => row.step === nextStep);
	const nextScheduledAt = resolveNextScheduledAt(
		nextRow,
		reanchorUpdates.find((u) => u.step === nextStep)?.scheduledAt
	);

	return {
		id,
		memoId: target.memoId,
		memoTitle: target.memoTitle,
		completedAt,
		nextScheduledAt
	};
}
