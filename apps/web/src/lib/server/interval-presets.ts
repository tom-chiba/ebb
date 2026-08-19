import {
	and,
	count,
	eq,
	inArray,
	intervalPresets,
	isNull,
	memos,
	or,
	reviews,
	userSettings,
	type BatchItem,
	type Db
} from '@ebb/db';
import { diffIntervals, parseIntervals, type IntervalDiffEntry } from '@ebb/core';
import { queryInChunks } from './db-chunk';
import {
	ConflictError,
	isUniqueConstraintViolation,
	NotFoundError,
	ValidationError
} from './errors';
import {
	buildReviewScheduleClaimStatements,
	computeReviewRecalculation,
	loadReviewRecalculationInputs
} from './reviews';

// #15/#16 が着地する前の暫定値として #14 で導入された、システム標準プリセットの
// 固定 slug id。#18 でユーザーが一度も既定プリセットを選んでいない場合の
// 最終フォールバックとして引き続き使う。
export const DEFAULT_INTERVAL_PRESET_ID = 'system-standard';

export const PRESET_NAME_MAX_LENGTH = 100;

// 1回の db.batch() に積む文の数の上限（プリセット UPDATE + 影響メモ数 ×
// (DELETE 1 + INSERT 最大 MAX_INTERVAL_COUNT 件)）。「Free プランは CPU 10ms/リクエスト」
// （docs/design-decisions.md の要注意点2）という既知の制約に対し、無制限に積む設計を
// 避けるための安全弁。本アプリの想定ユーザー規模（自分を含む一般公開だが個人利用が
// 中心）ではまず到達しない、十分に大きい値として選んだ任意の上限。
export const MAX_BATCH_STATEMENTS = 500;

function parseIntervalsOrValidationError(raw: string): number[] {
	try {
		return parseIntervals(raw);
	} catch (err) {
		throw new ValidationError(err instanceof Error ? err.message : 'invalid intervals');
	}
}

// intervals も返す。createMemo（#16）が reviews をバッチ生成する際に使う。
// updateMemo（プリセット変更時のアクセス可否チェックのみ、reviews は再生成しない）・
// setDefaultPresetForUser（#18）は戻り値を無視して呼ぶだけにしている。
export async function getAccessiblePreset(db: Db, userId: string, intervalPresetId: string) {
	const rows = await db
		.select({ intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(
			and(
				eq(intervalPresets.id, intervalPresetId),
				or(isNull(intervalPresets.userId), eq(intervalPresets.userId, userId))
			)
		)
		.limit(1)
		.all();
	const preset = rows[0];
	if (!preset) {
		throw new ValidationError('intervalPresetId does not reference an accessible preset');
	}
	return preset;
}

export interface PresetNameAndIntervals {
	name: string;
	intervals: number[];
}

// メモ詳細画面（#60）向け。メモが参照する intervalPresetId は所有者チェック済みの
// FK 値であり、getAccessiblePreset のような userId 一致/システム標準の判定は不要
// （メモ自体の所有権は呼び出し元の getMemo が既に検証している）。
export async function getPresetNameAndIntervals(
	db: Db,
	presetId: string
): Promise<PresetNameAndIntervals | undefined> {
	const rows = await db
		.select({ name: intervalPresets.name, intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(eq(intervalPresets.id, presetId))
		.limit(1)
		.all();
	return rows[0];
}

export interface PresetSummary {
	id: string;
	name: string;
	intervals: number[];
	isSystem: boolean;
	// このプリセットを使っている memo が1件以上あるか（アーカイブ済みも含む。
	// memos.interval_preset_id の FK は onDelete: 'no action' のため、アーカイブ済み
	// メモが参照している間はプリセット自体を削除できない）。削除ボタンの無効化に使う。
	inUse: boolean;
	// このプリセットを使っている memo の件数（アーカイブ済みも含む。inUse と同じ集計の
	// 件数版。設定画面のプリセット一覧（#62）で「使用中メモ件数」として表示する）。
	inUseCount: number;
}

// システム標準プリセット + このユーザー自身のカスタムプリセットの一覧。
export async function listPresetsForUser(db: Db, userId: string): Promise<PresetSummary[]> {
	const presetRows = await db
		.select({
			id: intervalPresets.id,
			name: intervalPresets.name,
			intervals: intervalPresets.intervals,
			userId: intervalPresets.userId
		})
		.from(intervalPresets)
		.where(or(isNull(intervalPresets.userId), eq(intervalPresets.userId, userId)))
		.all();

	// 対象プリセットごとの使用中 memo 件数を1クエリでまとめて調べる（プリセットごとに
	// 問い合わせない）。userId で絞らないと、システム標準プリセット（全ユーザー共有）の
	// 件数が「自分が使っている件数」ではなく「他ユーザーも含め誰かが使っている件数」に
	// なってしまい、他ユーザーの存在に関する情報が（ページの data に含まれる形で）漏れる
	// （#18 の inUse 判定に対する正確性レビュー指摘と同じ理由）。
	const usageRows = await db
		.select({ intervalPresetId: memos.intervalPresetId, count: count() })
		.from(memos)
		.where(eq(memos.userId, userId))
		.groupBy(memos.intervalPresetId)
		.all();
	const usageCounts = new Map(usageRows.map((row) => [row.intervalPresetId, row.count]));

	return presetRows
		.map((preset) => {
			const inUseCount = usageCounts.get(preset.id) ?? 0;
			return {
				id: preset.id,
				name: preset.name,
				intervals: preset.intervals,
				isSystem: preset.userId === null,
				inUse: inUseCount > 0,
				inUseCount
			};
		})
		.sort((a, b) => {
			if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
			return a.name.localeCompare(b.name, 'ja');
		});
}

export async function createCustomPreset(
	db: Db,
	userId: string,
	name: string,
	rawIntervals: string
) {
	const trimmedName = name.trim();
	if (trimmedName.length === 0) {
		throw new ValidationError('name is required');
	}
	if (trimmedName.length > PRESET_NAME_MAX_LENGTH) {
		throw new ValidationError(`name must be ${PRESET_NAME_MAX_LENGTH} characters or fewer`);
	}
	const intervals = parseIntervalsOrValidationError(rawIntervals);

	const rows = await db
		.insert(intervalPresets)
		.values({ userId, name: trimmedName, intervals })
		.returning();
	const preset = rows[0];
	if (!preset) throw new Error('failed to create preset');
	return preset;
}

// このユーザー自身が所有するカスタムプリセットのみを返す。「存在しない」場合と
// 「他ユーザーのカスタムプリセットを指している」場合は区別せず NotFoundError にする
// （#13/#17 と同じ、存在有無を秘匿する方針）。一方システム標準プリセット
// （userId が NULL）を指した場合は、対象が何であるか自体は公開情報のため、
// 「編集・削除できない」という理由を明示した ValidationError にする。
export async function getOwnedCustomPreset(db: Db, userId: string, presetId: string) {
	const rows = await db
		.select({
			id: intervalPresets.id,
			userId: intervalPresets.userId,
			name: intervalPresets.name,
			intervals: intervalPresets.intervals
		})
		.from(intervalPresets)
		.where(eq(intervalPresets.id, presetId))
		.limit(1)
		.all();
	const preset = rows[0];
	if (preset && preset.userId === null) {
		throw new ValidationError('system presets cannot be edited or deleted');
	}
	if (!preset || preset.userId !== userId) {
		throw new NotFoundError('interval preset not found');
	}
	return preset;
}

// このプリセットを使っている、非アーカイブメモの id 一覧。プレビュー（件数のみ必要）
// と実行（再計算対象そのもの）の両方が「対象メモをどう選ぶか」を必ずこの関数経由で
// 決める。アーカイブ済みメモを対象外にする理由: archiveMemo（#16）はアーカイブと
// 同時に未完了 reviews を削除しており、「アーカイブ済みメモに未完了 reviews が
// 残らない」不変条件（docs/schema.md）を再計算対象に含めることで静かに破ってしまうため。
// この SELECT から db.batch() 確定までの間に別リクエストが同じメモを archiveMemo
// した場合の残存レースは、claim（batch A）自身のガード（memoIsNotArchived）が
// 実行時点で archivedAt をライブに確認するため、勝敗判定の時点では防がれる。
// ただし claim に勝った後・batch B（reviews への実際の INSERT）実行前に
// archiveMemo が割り込む窓は別に残る（正確性レビューで指摘、
// docs/design-decisions.md の #18・#85 節に記録）。
async function collectAffectedMemoIds(db: Db, presetId: string): Promise<string[]> {
	const rows = await db
		.select({ id: memos.id })
		.from(memos)
		.where(and(eq(memos.intervalPresetId, presetId), isNull(memos.archivedAt)))
		.all();
	return rows.map((row) => row.id);
}

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

// queryInChunks（./db-chunk）のチャンク分割は、D1 の1クエリあたり bind パラメータ数
// 上限（ローカル実測でちょうど100件、101件から `too many SQL variables`）に対する
// 対処。MAX_BATCH_STATEMENTS（500）が許容する最大メモ数（悲観的見積もりで最大250件、
// #84 時点の249件とほぼ同水準）はこれを容易に超えるため、$lib/server/reviews.ts の
// loadReviewRecalculationInputs（#84 で一括取得に変更した際に追加）と、下記
// updateCustomPresetIntervals 内の負けたメモのアーカイブ再確認（Issue #85 で追加）が
// このヘルパー経由でチャンク分割する（#18 の正確性レビューで指摘。実際に251件規模の
// テストで生の D1 エラーを再現して確認した）。

// プリセット編集画面（#63）の「このプリセットを使っているメモ」一覧・削除ボタンの
// 活性判定に使う。deleteCustomPreset の使用中判定と同じく、アーカイブ済みメモも
// 含めて「使用中」とみなす（memos.interval_preset_id は onDelete: 'no action' で
// あり、アーカイブ済みメモが参照している間はプリセットを削除できないため、この
// 画面で見せる「使用中」もその制約と一致させる）。
export async function listMemosUsingPreset(
	db: Db,
	presetId: string
): Promise<{ id: string; title: string }[]> {
	return db
		.select({ id: memos.id, title: memos.title })
		.from(memos)
		.where(eq(memos.intervalPresetId, presetId))
		.all();
}

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
		// db.batch は静的に非空とわかるタプル型を要求する（#17 の completeReview と同じ
		// 理由）。claimPairs.length > 0 のガードにより実行時には常に1件以上になるが、
		// 配列の展開は配列型のままでタプル型と直接オーバーラップしないため、
		// unknown 経由でキャストする。
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

	// db.batch は静的に非空とわかるタプル型を要求する（#17 の completeReview と同じ理由）。
	// updatePresetStatement は常に配列先頭にあるため実行時には常に1件以上になる。
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

export async function deleteCustomPreset(db: Db, userId: string, presetId: string): Promise<void> {
	await getOwnedCustomPreset(db, userId, presetId);

	// アーカイブ済みメモも含めて使用中判定する。memos.interval_preset_id の FK は
	// onDelete: 'no action' のため、アーカイブ済みメモが参照している間は DB 側でも
	// 削除できない。ここで先にチェックし、生の FK エラーではなく分かりやすい
	// メッセージを返す。
	const usageRows = await db
		.select({ id: memos.id })
		.from(memos)
		.where(eq(memos.intervalPresetId, presetId))
		.limit(1)
		.all();
	if (usageRows.length > 0) {
		throw new ValidationError('このプリセットは使用中のメモがあるため削除できません');
	}

	await db
		.delete(intervalPresets)
		.where(and(eq(intervalPresets.id, presetId), eq(intervalPresets.userId, userId)));
}

// 新規メモ作成時の既定プリセットをユーザーごとに切り替える。system 標準 or
// このユーザー自身のカスタムプリセットのみ指定できる（getAccessiblePreset で検証）。
// user_settings.default_interval_preset_id を守る DB トリガー（0009 migration）とは
// 独立した、アプリ層での早期検証。
export async function setDefaultPresetForUser(
	db: Db,
	userId: string,
	presetId: string
): Promise<void> {
	await getAccessiblePreset(db, userId, presetId);
	await db
		.insert(userSettings)
		.values({ userId, defaultIntervalPresetId: presetId })
		.onConflictDoUpdate({
			target: userSettings.userId,
			set: { defaultIntervalPresetId: presetId }
		});
}

// ユーザーが既定プリセットを未設定、または参照先が削除済み（onDelete: 'set null'）の
// 場合は DEFAULT_INTERVAL_PRESET_ID にフォールバックする。
export async function getDefaultPresetId(db: Db, userId: string): Promise<string> {
	const rows = await db
		.select({ defaultIntervalPresetId: userSettings.defaultIntervalPresetId })
		.from(userSettings)
		.where(eq(userSettings.userId, userId))
		.limit(1)
		.all();
	return rows[0]?.defaultIntervalPresetId ?? DEFAULT_INTERVAL_PRESET_ID;
}
