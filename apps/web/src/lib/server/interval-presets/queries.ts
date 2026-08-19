import { and, count, eq, intervalPresets, isNull, memos, or, userSettings, type Db } from '@ebb/db';
import { NotFoundError, ValidationError } from '../errors';

// #15/#16 が着地する前の暫定値として #14 で導入された、システム標準プリセットの
// 固定 slug id。#18 でユーザーが一度も既定プリセットを選んでいない場合の
// 最終フォールバックとして引き続き使う。
export const DEFAULT_INTERVAL_PRESET_ID = 'system-standard';

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

// getDueReviewDetail・completeReview（reviews/complete-review.ts）の両方が使う、
// 「プリセットの intervals を id から取得する」クエリの共通化（設計レビューで指摘）。
// reviews 側からはバレル（./index.ts）を経由せずこのファイルを直接 import する
// （presets/index.ts が reviews/index.ts に依存しており、逆方向の依存をバレル経由に
// すると循環になるため）。
export async function getPresetIntervals(db: Db, presetId: string): Promise<number[]> {
	const presetRows = await db
		.select({ intervals: intervalPresets.intervals })
		.from(intervalPresets)
		.where(eq(intervalPresets.id, presetId))
		.limit(1)
		.all();
	return presetRows[0]?.intervals ?? [];
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
export async function collectAffectedMemoIds(db: Db, presetId: string): Promise<string[]> {
	const rows = await db
		.select({ id: memos.id })
		.from(memos)
		.where(and(eq(memos.intervalPresetId, presetId), isNull(memos.archivedAt)))
		.all();
	return rows.map((row) => row.id);
}

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
