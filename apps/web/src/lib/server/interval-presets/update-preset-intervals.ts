import {
	and,
	eq,
	inArray,
	intervalPresets,
	isNull,
	memos,
	reviews,
	type BatchItem,
	type Db
} from '@ebb/db';
import { diffIntervals, type IntervalDiffEntry } from '@ebb/core';
import { queryInChunks } from '../db-chunk';
import { ConflictError, isUniqueConstraintViolation, ValidationError } from '../errors';
// このファイルは reviews ドメインのバレル（../reviews/index.ts）に依存する。逆方向
// （reviews 側からこのファイルへ）の依存は無い。reviews/complete-review.ts が
// このディレクトリの getPresetIntervals（queries.ts）を直接 import しているのは
// このバレルではなく queries.ts 単体のため、循環にはならない。
import {
	buildReviewScheduleClaimStatements,
	computeReviewRecalculation,
	loadReviewRecalculationInputs
} from '../reviews';
import { parseIntervalsOrValidationError } from './commands';
import { collectAffectedMemoIds, getOwnedCustomPreset } from './queries';

// 1回の db.batch() に積む文の数の上限（プリセット UPDATE + 影響メモ数 ×
// (DELETE 1 + INSERT 最大 MAX_INTERVAL_COUNT 件)）。「Free プランは CPU 10ms/リクエスト」
// （docs/design-decisions.md の要注意点2）という既知の制約に対し、無制限に積む設計を
// 避けるための安全弁。本アプリの想定ユーザー規模（自分を含む一般公開だが個人利用が
// 中心）ではまず到達しない、十分に大きい値として選んだ任意の上限。
export const MAX_BATCH_STATEMENTS = 500;

// 1メモあたりに積む文数の上限。Issue #85 で claim（DELETE 1 + review_schedules の
// version bump 1）と実際の reviews INSERT が別々の db.batch()（batch A ・ batch B）
// に分離されたため、両者を合算した値ではなく、各 batch 単体での上限を見積もる
// 必要がある。batch A は 1メモあたり2文（DELETE + bump）、batch B は
// 「プリセット UPDATE 1件 + 1メモあたり最大1文（INSERT）」であり、メモ数が
// 1件以上なら batch A の 2N が batch B の 1+N を常に下回らないため、batch A が
// 律速する。よってここでは batch A の上限（2）を使う。
const MAX_STATEMENTS_PER_MEMO = 2;

// プレビュー・確定共通のバッチ上限超過エラー。報告の仕方（メッセージ文言・
// 例外の種類）は1箇所にまとめ、片方だけ文言を直し忘れる事故を避ける。
function assertWithinBatchStatementLimit(statementCount: number): void {
	if (statementCount > MAX_BATCH_STATEMENTS) {
		throw new ValidationError('このプリセットを使っているメモが多すぎるため、一度に更新できません');
	}
}

// 対象メモ数から、update 実行時に各 db.batch()（batch A・batch B）へ積む文数の
// 悲観的上限を見積もる。batch A（各メモ最大 MAX_STATEMENTS_PER_MEMO 件）の見積もりは
// batch B（プリセット UPDATE 1件 + 各メモ最大1件）を常に下回らないため、batch A の
// 見積もりだけを使えば両方の batch を保証できる。実際の文数は常にこの悲観的
// 見積もり以下になるため、これが上限を超えなければ updateCustomPresetIntervals は
// 必ず成功する（＝プレビューが「N件の予定が更新されます」と成功を示したのに、
// 確定操作だけが後から拒否される非対称を防ぐ。正確性レビューで指摘）。
function estimateWorstCaseBatchStatementCount(memoCount: number): number {
	return memoCount * MAX_STATEMENTS_PER_MEMO;
}

// queryInChunks（../db-chunk）のチャンク分割は、D1 の1クエリあたり bind パラメータ数
// 上限（ローカル実測でちょうど100件、101件から `too many SQL variables`）に対する
// 対処。MAX_BATCH_STATEMENTS（500）が許容する最大メモ数（悲観的見積もりで最大250件、
// #84 時点の249件とほぼ同水準）はこれを容易に超えるため、reviews/schedule-recalculation.ts の
// loadReviewRecalculationInputs（#84 で一括取得に変更した際に追加）と、下記
// updateCustomPresetIntervals 内の負けたメモのアーカイブ再確認（Issue #85 で追加）が
// このヘルパー経由でチャンク分割する（#18 の正確性レビューで指摘。実際に251件規模の
// テストで生の D1 エラーを再現して確認した）。

// プリセット変更（intervals の編集）で更新される reviews の件数のプレビュー。
// 「N 件の予定が更新されます」の表示用。所有権チェック（getOwnedCustomPreset）と
// intervals の構文検証（parseIntervalsOrValidationError）を実行系（
// updateCustomPresetIntervals）と全く同じ順序で行う。これを省略すると、
// 未確定（confirmed=false）のプレビュー経路だけが認可・検証をすべて素通りし、
// 他ユーザーの custom プリセットやシステムプリセットの id を渡すことでそのプリセットを
// 使っている（自分のものではない）メモの未完了 reviews 件数を取得できてしまう
// （正確性レビューで指摘された情報漏洩）。
// diff（#63、変更前後のステップ差分表示用）は getOwnedCustomPreset が返す現在の
// intervals と、この呼び出しで検証済みの新しい intervals を比較するだけの
// 副産物であり、この関数以外で計算する必要はない。
export async function previewPresetIntervalsUpdate(
	db: Db,
	userId: string,
	presetId: string,
	rawIntervals: string
): Promise<{ previewCount: number; diff: IntervalDiffEntry[] }> {
	const owned = await getOwnedCustomPreset(db, userId, presetId);
	const intervals = parseIntervalsOrValidationError(rawIntervals);

	const memoIds = await collectAffectedMemoIds(db, presetId);
	assertWithinBatchStatementLimit(estimateWorstCaseBatchStatementCount(memoIds.length));

	// #84: 対象メモ1件ずつ SELECT する代わりに、対象メモ数に依らない一括取得
	// （loadReviewRecalculationInputs）＋ DB アクセスなしの純粋関数
	// （computeReviewRecalculation）で件数を積み上げる。この集計・計画生成ロジックは
	// updateCustomPresetIntervals（確定側）と全く同じものを使う。
	const inputs = await loadReviewRecalculationInputs(db, memoIds);
	let previewCount = 0;
	for (const memoId of memoIds) {
		const input = inputs.get(memoId);
		// collectAffectedMemoIds が返した直後に見つからなくなるのは
		// loadReviewRecalculationInputs のコメントに記した通り理屈上は起こらないが、
		// 起きた場合は対象から除外する。
		if (!input) continue;
		previewCount += computeReviewRecalculation(memoId, input, intervals).affectedCount;
	}

	return { previewCount, diff: diffIntervals(owned.intervals, intervals) };
}

export async function updateCustomPresetIntervals(
	db: Db,
	userId: string,
	presetId: string,
	rawIntervals: string
): Promise<{ updatedReviewsCount: number }> {
	await getOwnedCustomPreset(db, userId, presetId);
	const intervals = parseIntervalsOrValidationError(rawIntervals);

	const memoIds = await collectAffectedMemoIds(db, presetId);
	// プレビューと同じ悲観的見積もりで、対象メモの再計算プランを取得する前に拒否する。
	// これが無いと、UIの確認フローを迂回して confirmed=true を直接POSTした場合に、
	// 大量メモ分の loadReviewRecalculationInputs とアーカイブ再確認クエリを全て
	// 実行してから最後に拒否することになり、MAX_BATCH_STATEMENTS を設けた本来の
	// 目的（CPU時間の安全弁）を実行系では部分的にしか達成できていなかった
	// （#18 の設計レビューで指摘）。
	assertWithinBatchStatementLimit(estimateWorstCaseBatchStatementCount(memoIds.length));

	// #84: 対象メモ1件につき3 SELECT（memo作成日時・最新の完了済みstep・未完了件数）を
	// 発行していた旧実装（メモ数に比例してクエリが増える）を、対象メモ数に依らない
	// 一括取得（loadReviewRecalculationInputs）＋ DB アクセスなしの純粋関数
	// （computeReviewRecalculation）に置き換えた。previewPresetIntervalsUpdate と
	// 全く同じ集計・計画生成ロジックを使う。
	// memoId と plan を最初からペアで持ち回ることで、後段のフィルタが2つの並行配列を
	// index で対応付ける必要をなくす（設計レビューで指摘。index対応付けだと
	// 「memoIds と plans が同じ順序・同じ長さ」という別の不変条件に暗黙に依存してしまう）。
	const inputs = await loadReviewRecalculationInputs(db, memoIds);
	const memoPlans = memoIds
		.map((memoId) => {
			const input = inputs.get(memoId);
			// loadReviewRecalculationInputs のコメントの通り理屈上は起こらないが、
			// 起きた場合は claim（下記）と同じく対象から除外する。
			if (!input) return undefined;
			return {
				memoId,
				expectedVersion: input.version,
				plan: computeReviewRecalculation(memoId, input, intervals)
			};
		})
		.filter(
			(
				entry
			): entry is {
				memoId: string;
				expectedVersion: number;
				plan: ReturnType<typeof computeReviewRecalculation>;
			} => entry !== undefined
		);

	// Issue #85: 各メモの claim（DELETE + review_schedules.version bump）を1つの
	// db.batch()（batch A）にまとめて実行する。version が読み取り時
	// （loadReviewRecalculationInputs）のまま変わっていない（別リクエストの
	// completeReview・別のプリセット変更が割り込んでいない）memo のみが「勝つ」。
	// claim 自身のガードが対象メモの archivedAt を直接見るため、旧実装が
	// batch 実行直前に別クエリで行っていた「対象メモのアーカイブ再確認」は、
	// claim の勝敗判定そのものからは不要になった。ただし batch A コミット後・
	// batch B（下記、reviews への実際の INSERT）実行前の窓で archiveMemo が
	// 割り込んだ場合、batch B の INSERT 自体にはアーカイブ確認のガードが無い
	// ため、アーカイブ済みメモに未完了 reviews が復活しうる残存レースは残る
	// （#18 節と同種・同程度の窓。正確性レビューで指摘）。
	// DELETE 文をまとめて先に積み、bump 文をまとめて後に積む（各メモの DELETE は
	// 必ず自分の bump より先に実行される必要があるが、メモ同士は独立な行を操作する
	// ため互いの順序は問わない）。bump は .returning({ memoId }) で「勝った」memoId
	// 自身を返すため、結果を読む側は「bump 群がまとめて後半に来る」という粗い
	// 位置の知識（`claimResults.slice(claimPairs.length)`）だけで済む（設計レビューで
	// 指摘: 以前は flatMap で [delete, bump] を交互に積み、
	// `claimResults[i * 2 + 1]` という「何番目が誰の bump か」まで踏み込んだ暗黙の
	// ストライドで結果を読んでおり、積む側・読む側の2箇所に同じ細かいレイアウト知識が
	// 分散していた。今回の形は「誰の」までは値（memoId）から読むため、その分の
	// 位置依存は無くなっている）。
	const claimPairs = memoPlans.map(({ memoId, expectedVersion }) => ({
		memoId,
		...buildReviewScheduleClaimStatements(db, memoId, expectedVersion)
	}));
	const wonMemoIds = new Set<string>();
	if (claimPairs.length > 0) {
		const claimStatements = [
			...claimPairs.map(({ deleteStatement }) => deleteStatement),
			...claimPairs.map(({ bumpStatement }) => bumpStatement)
		];
		// db.batch は静的に非空とわかるタプル型を要求する（#17 の reviews/complete-review.ts の
		// completeReview と同じ理由）。claimPairs.length > 0 のガードにより実行時には
		// 常に1件以上になるが、配列の展開は配列型のままでタプル型と直接オーバーラップ
		// しないため、unknown 経由でキャストする。
		const claimResults = await db.batch(
			claimStatements as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
		);
		const bumpResults = claimResults.slice(claimPairs.length) as { memoId: string }[][];
		for (const wonMemoId of bumpResults.flat().map((row) => row.memoId)) {
			wonMemoIds.add(wonMemoId);
		}
	}
	const wonPlans = memoPlans.filter(({ memoId }) => wonMemoIds.has(memoId));
	const loserMemoIds = memoPlans
		.map(({ memoId }) => memoId)
		.filter((memoId) => !wonMemoIds.has(memoId));

	const updatePresetStatement = db
		.update(intervalPresets)
		.set({ intervals })
		.where(eq(intervalPresets.id, presetId));
	const insertStatements = wonPlans
		.filter(({ plan }) => plan.newRows.length > 0)
		.map(({ plan }) => db.insert(reviews).values(plan.newRows));

	// db.batch は静的に非空とわかるタプル型を要求する（#17 の reviews/complete-review.ts の
	// completeReview と同じ理由）。updatePresetStatement は常に配列先頭にあるため
	// 実行時には常に1件以上になる。
	const statements: [typeof updatePresetStatement, ...BatchItem<'sqlite'>[]] = [
		updatePresetStatement,
		...insertStatements
	];

	try {
		await db.batch(statements);
	} catch (err) {
		// batch A（claim）は既にコミット済みであり、勝った memo の reviews は
		// 削除された状態で確定している。batch B（ここ）が丸ごと失敗すると
		// （下記 unique 制約 backstop の発火・一過性の D1 エラー等）、batch B は
		// 単一の db.batch() のため INSERT 側はロールバックされるが、既にコミット
		// 済みの batch A の DELETE は元に戻らない。この場合、勝った memo の
		// 未完了 reviews は失われたままになる（`changeMemoPreset` 側の
		// `commitReviewRecalculation` が持つのと同種の残存リスクで、
		// docs/design-decisions.md #85 節に記録。同じプリセットで再実行すれば
		// computeReviewRecalculation が完了済み行だけから再計算できるため
		// 回復可能）。
		//
		// この catch 自体は、claim に勝った直後・この db.batch() 実行前のごく
		// 狭い窓に、別の書き込みが同じ memoId に対して先に同じ step 番号を
		// 使ってしまった場合の backstop（#82 節が記録する残存レースと同種、
		// 完全な排除はできない）。version の CAS が主たる検出手段になったことで、
		// この分岐に到達する経路は大幅に狭まったが、生の DB エラーとして 500 に
		// なるのではなく、ユーザーにリトライを促す 409 として扱う点は変えない。
		if (isUniqueConstraintViolation(err, 'reviews.step')) {
			throw new ConflictError(
				'このプリセットを使っているメモの復習予定が同時に更新されました。もう一度お試しください。'
			);
		}
		throw err;
	}

	// batch B のコミット後に負けたメモの生死を確認する。batch A 直後（batch B
	// 実行前）に判定していた旧実装は、負けたメモが1件でもいると batch B の
	// 実行自体を中断しており、既に claim に勝っていた memo の未完了 reviews が
	// 永久に失われる不具合があった（実機で再現・advisor 指摘）。batch B の
	// コミット後に判定することで、勝った memo の reviews は既に INSERT 済みの
	// ため失われない。アーカイブ済みで負けたメモは既存の不変条件（アーカイブ
	// 済みメモに未完了 reviews は残らない）の範囲内であり、静かに除外してよい。
	//
	// ここで投げる ConflictError は、上の catch 節（batch B 自体が失敗した
	// ケース）とは意味が異なる: batch B は既にコミット済みであり、プリセットの
	// intervals も勝った memo の reviews も保存済みの「部分成功」状態である。
	// メッセージを他の ConflictError と同じ文言にすると、実際には保存されている
	// のに「何も保存されなかったので再試行してほしい」と誤解させる（設計レビューで
	// 指摘）。負けたメモだけ古い intervals のままなので、そのメモに対して同じ
	// 操作を再実行すれば揃う旨を明示する。
	if (loserMemoIds.length > 0) {
		const stillActiveLoserRows = await queryInChunks(loserMemoIds, (ids) =>
			db
				.select({ id: memos.id })
				.from(memos)
				.where(and(inArray(memos.id, ids), isNull(memos.archivedAt)))
				.all()
		);
		if (stillActiveLoserRows.length > 0) {
			throw new ConflictError(
				'プリセットは更新されましたが、一部のメモは同時に更新されたため復習予定が反映されていません。もう一度お試しください。'
			);
		}
	}

	// hidden field 等でクライアントから渡された件数を信用せず、実行直前に読み直した
	// 実数の合計を返す（#17 のバナー件数ズレと同型の罠を避けるため）。claim に負けた
	// メモ（version 不一致・アーカイブ済み）分は実際には再計算していないため、ここでも
	// 含めない。
	return {
		updatedReviewsCount: wonPlans.reduce((sum, { plan }) => sum + plan.affectedCount, 0)
	};
}
