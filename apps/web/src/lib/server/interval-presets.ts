import {
	and,
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
import { parseIntervals } from '@ebb/core';
import {
	ConflictError,
	isUniqueConstraintViolation,
	NotFoundError,
	ValidationError
} from './errors';
import { planReviewRecalculation, type ReviewRecalculationPlan } from './reviews';

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

export interface PresetSummary {
	id: string;
	name: string;
	intervals: number[];
	isSystem: boolean;
	// このプリセットを使っている memo が1件以上あるか（アーカイブ済みも含む。
	// memos.interval_preset_id の FK は onDelete: 'no action' のため、アーカイブ済み
	// メモが参照している間はプリセット自体を削除できない）。削除ボタンの無効化に使う。
	inUse: boolean;
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

	// 対象プリセットごとに使用中の memo が存在するかを1クエリでまとめて調べる
	// （プリセットごとに問い合わせない）。userId で絞らないと、システム標準プリセット
	// （全ユーザー共有）の inUse が「自分が使っているか」ではなく「他ユーザーも含め
	// 誰かが使っているか」になってしまい、他ユーザーの存在に関する情報が
	// （UI上は未使用でも、ページの data には含まれる形で）漏れる
	// （正確性レビューで指摘）。
	const usageRows = await db
		.select({ intervalPresetId: memos.intervalPresetId })
		.from(memos)
		.where(eq(memos.userId, userId))
		.groupBy(memos.intervalPresetId)
		.all();
	const usedPresetIds = new Set(usageRows.map((row) => row.intervalPresetId));

	return presetRows
		.map((preset) => ({
			id: preset.id,
			name: preset.name,
			intervals: preset.intervals,
			isSystem: preset.userId === null,
			inUse: usedPresetIds.has(preset.id)
		}))
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
async function getOwnedCustomPreset(db: Db, userId: string, presetId: string) {
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
// した場合の残存レースは、updateCustomPresetIntervals 側の再確認（
// stillActiveMemoIds）で狭めているが完全には防げない（正確性レビューで
// 指摘、docs/design-decisions.md の #18 節に記録）。
async function collectAffectedMemoIds(db: Db, presetId: string): Promise<string[]> {
	const rows = await db
		.select({ id: memos.id })
		.from(memos)
		.where(and(eq(memos.intervalPresetId, presetId), isNull(memos.archivedAt)))
		.all();
	return rows.map((row) => row.id);
}

// planReviewRecalculation が1メモあたりに積む文数の上限（DELETE 1 + INSERT 1）。
// 実際の文数はこれより少ないことがある（完了済み行のみで DELETE 不要、新
// intervals が0件で INSERT 不要、等）ため、実行系（updateCustomPresetIntervals）
// はここではなく実際に組み立てた statements.length で判定する。プレビューは
// 逆に、実行前に安全側（悲観的）に見積もる必要があるため、この上限値を使う。
const MAX_STATEMENTS_PER_MEMO = 2;

// プレビュー・確定共通のバッチ上限超過エラー。判定方法（見積もり方 vs 実測値）は
// 呼び出し元ごとに異なるが、報告の仕方（メッセージ文言・例外の種類）は1箇所に
// まとめ、片方だけ文言を直し忘れる事故を避ける（設計レビューで指摘）。
function assertWithinBatchStatementLimit(statementCount: number): void {
	if (statementCount > MAX_BATCH_STATEMENTS) {
		throw new ValidationError('このプリセットを使っているメモが多すぎるため、一度に更新できません');
	}
}

// 対象メモ数から、update 実行時に db.batch() へ積む文数（プリセット UPDATE 1件 +
// 各メモ最大 MAX_STATEMENTS_PER_MEMO 件）の悲観的上限を見積もる。実際の文数は
// 常にこの悲観的見積もり以下になるため、これが上限を超えなければ
// updateCustomPresetIntervals は必ず成功する（＝プレビューが「N件の予定が
// 更新されます」と成功を示したのに、確定操作だけが後から拒否される非対称を防ぐ。
// 正確性レビューで指摘）。
function estimateWorstCaseBatchStatementCount(memoCount: number): number {
	return 1 + memoCount * MAX_STATEMENTS_PER_MEMO;
}

// D1 は1クエリあたりの bind パラメータ数に上限があり（ローカル実行で実測したところ
// ちょうど100件で、101件から `too many SQL variables` になる。Cloudflare の
// ドキュメントが示す上限と一致）、MAX_BATCH_STATEMENTS（500）が許容する最大
// メモ数（悲観的見積もりで最大249件）はこれを容易に超える。`inArray` にメモ id を
// まとめて渡す箇所は必ずこの単位でチャンク分割してからクエリを発行する
// （正確性レビューで指摘。実際に251件規模のテストで生の D1 エラーを再現して確認した）。
// これは「1クエリの bind パラメータ総数」の上限であり「1つの inArray に渡せる件数」
// ではない点に注意（設計レビューで指摘）。現状 queryInChunks を使うクエリは
// inArray 1つだけで他に bind を持たないため一致しているが、条件を追加する際は
// チャンクサイズも見直すこと。同様に、reviews への1回の INSERT 文
// （$lib/server/reviews.ts の planReviewRecalculation）が使う bind 数は
// 「新 intervals の要素数（@ebb/core の MAX_INTERVAL_COUNT が上限）× 1行あたりの
// カラム数」であり、MAX_INTERVAL_COUNT を将来引き上げる場合はこの上限との関係も
// 見直す必要がある。
const D1_MAX_BIND_PARAMS = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// `inArray` にまとめて渡す id 一覧を D1_MAX_BIND_PARAMS 単位に分割してクエリを並列
// 発行し、結果を1つに結合する。空配列なら（chunk が空配列を返すため）そのままクエリ
// 0件で空配列を返す。countIncompleteReviewsForMemos・updateCustomPresetIntervals
// 内のアーカイブ再確認の両方が、この同じヘルパー経由でチャンク分割する
// （設計レビューで指摘、ロジックの重複と分岐の複雑化を避けるため共通化）。
async function queryInChunks<T, R>(
	ids: readonly T[],
	query: (chunkIds: T[]) => Promise<R[]>
): Promise<R[]> {
	const results = await Promise.all(chunk(ids, D1_MAX_BIND_PARAMS).map(query));
	return results.flat();
}

// 対象メモ群の未完了 reviews 件数。プレビュー（countだけ必要）と実行結果の返り値
// （updateCustomPresetIntervals、実際に削除された件数の合計）の両方が
// 「非アーカイブメモの未完了 reviews」という同じ定義を共有するための唯一の実装。
async function countIncompleteReviewsForMemos(db: Db, memoIds: string[]): Promise<number> {
	const rows = await queryInChunks(memoIds, (ids) =>
		db
			.select({ id: reviews.id })
			.from(reviews)
			.where(and(inArray(reviews.memoId, ids), isNull(reviews.completedAt)))
			.all()
	);
	return rows.length;
}

// プリセット変更（intervals の編集）で更新される reviews の件数のプレビュー。
// 「N 件の予定が更新されます」の表示用。所有権チェック（getOwnedCustomPreset）と
// intervals の構文検証（parseIntervalsOrValidationError）を実行系（
// updateCustomPresetIntervals）と全く同じ順序で行う。これを省略すると、
// 未確定（confirmed=false）のプレビュー経路だけが認可・検証をすべて素通りし、
// 他ユーザーの custom プリセットやシステムプリセットの id を渡すことでそのプリセットを
// 使っている（自分のものではない）メモの未完了 reviews 件数を取得できてしまう
// （正確性レビューで指摘された情報漏洩）。
export async function previewPresetIntervalsUpdate(
	db: Db,
	userId: string,
	presetId: string,
	rawIntervals: string
): Promise<{ previewCount: number }> {
	await getOwnedCustomPreset(db, userId, presetId);
	// 構文検証のみ行い、結果（新しい intervals）自体はプレビューの件数計算には
	// 使わない。「N件」は既存の未完了行のうち削除・作り直しの対象になる件数であり、
	// 新しい intervals の長さに依存しないため（詳細は countIncompleteReviewsForMemos）。
	parseIntervalsOrValidationError(rawIntervals);

	const memoIds = await collectAffectedMemoIds(db, presetId);
	assertWithinBatchStatementLimit(estimateWorstCaseBatchStatementCount(memoIds.length));
	return { previewCount: await countIncompleteReviewsForMemos(db, memoIds) };
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
	// 実測の statements.length による最終チェック（後述）の前に、プレビューと同じ
	// 悲観的見積もりで早期に拒否する。これが無いと、UIの確認フローを迂回して
	// confirmed=true を直接POSTした場合に、大量メモ分の planReviewRecalculation
	// （1メモあたりSELECT3回）とアーカイブ再確認クエリを全て実行してから最後に
	// 拒否することになり、MAX_BATCH_STATEMENTS を設けた本来の目的（CPU時間の安全弁）
	// を実行系では部分的にしか達成できていなかった（設計レビューで指摘）。
	assertWithinBatchStatementLimit(estimateWorstCaseBatchStatementCount(memoIds.length));
	// memoId と plan を最初からペアで持ち回ることで、後段のフィルタが2つの並行配列を
	// index で対応付ける必要をなくす（設計レビューで指摘。index対応付けだと
	// 「memoIds と plans が同じ順序・同じ長さ」という別の不変条件に暗黙に依存してしまう）。
	const memoPlans = await Promise.all(
		memoIds.map(async (memoId) => ({
			memoId,
			plan: await planReviewRecalculation(db, memoId, intervals)
		}))
	);

	// collectAffectedMemoIds の SELECT から db.batch() 確定までの間に、対象メモの
	// いずれかが別リクエストの archiveMemo によりアーカイブされていた場合、そのメモの
	// 再計算（特に INSERT）を実行すると「アーカイブ済みメモに未完了 reviews が残らない」
	// 不変条件を静かに破ってしまう（archiveMemo 自体は同期的に未完了行を削除するが、
	// この db.batch() の INSERT はそれを知らずに新しい未完了行を作ってしまうため）。
	// batch 実行の直前にもう一度だけアーカイブ状態を確認し、この時点までにアーカイブ
	// された memoId を対象から外すことで競合の窓を大幅に狭める（#17 の completeReview
	// が持つ同種の SELECT-then-write ハザードと同じ性質の残存レースであり、完全な排除
	// ではないことは docs/design-decisions.md の #18 節に記録済み。正確性レビューで指摘）。
	const stillActiveMemoIds = new Set(
		(await queryInChunks(memoIds, (ids) =>
			db
				.select({ id: memos.id })
				.from(memos)
				.where(and(inArray(memos.id, ids), isNull(memos.archivedAt)))
				.all()
		)).map((row) => row.id)
	);
	const activePlans = memoPlans
		.filter(({ memoId }) => stillActiveMemoIds.has(memoId))
		.map(({ plan }) => plan);
	const activeStatements = activePlans.flatMap((plan) => plan.statements);

	const updatePresetStatement = db
		.update(intervalPresets)
		.set({ intervals })
		.where(eq(intervalPresets.id, presetId));

	// db.batch は静的に非空とわかるタプル型を要求する（#17 の completeReview と同じ理由）。
	// updatePresetStatement は常に配列先頭にあるため実行時には常に1件以上になる。
	// 1メモあたり最大 MAX_STATEMENTS_PER_MEMO 文、かつ冒頭の
	// assertWithinBatchStatementLimit(estimateWorstCaseBatchStatementCount(...)) が
	// 既に memoIds.length を上限内に収めているため、activeStatements（memoIds の
	// 部分集合である activePlans 由来）の文数がこれを超えることはあり得ない。
	// 実測値による重複チェックは書かない（起こり得ないシナリオへの防御的検証）。
	const statements: [typeof updatePresetStatement, ...BatchItem<'sqlite'>[]] = [
		updatePresetStatement,
		...activeStatements
	];

	try {
		await db.batch(statements);
	} catch (err) {
		// planReviewRecalculation の SELECT（completedCount・未完了行の読み取り）と
		// この db.batch() 実行の間に、対象メモのいずれかで別リクエストの completeReview
		// が割り込むと、そこで計算した完了済みステップ数が古くなり、新しい INSERT が
		// 既に完了済みの step 番号と衝突して reviews_memoId_step_unique に違反しうる
		// （#17 の completeReview が同種の SELECT-then-write ハザードに対し
		// wonThisCompletion ガードで対処しているのと同じ根本原因。正確性レビューで
		// 指摘）。D1 の batch は単一の暗黙トランザクションのため、この違反時は
		// プリセット自体の UPDATE も含めてロールバックされる。生の DB エラーとして
		// 500 になるのではなく、ユーザーにリトライを促す 409 として扱う。
		if (isUniqueConstraintViolation(err, 'reviews.step')) {
			throw new ConflictError(
				'このプリセットを使っているメモの復習予定が同時に更新されました。もう一度お試しください。'
			);
		}
		throw err;
	}

	// hidden field 等でクライアントから渡された件数を信用せず、実行直前に読み直した
	// 実数の合計を返す（#17 のバナー件数ズレと同型の罠を避けるため）。直前にアーカイブ
	// されて対象から外れたメモ（activePlans に含まれない）分は実際には再計算していない
	// ため、ここでも含めない。
	return {
		updatedReviewsCount: activePlans.reduce((sum, plan) => sum + plan.affectedCount, 0)
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
