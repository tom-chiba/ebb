// 復習間隔のプリセットと計算ロジック。DB にも Date.now() にも依存しない純粋関数として実装する。

export type Hours = number;

export interface IntervalPreset {
	readonly id: string;
	readonly name: string;
	// 時間単位の間隔配列。最小単位・順序のバリデーションは #18 の責務（docs/schema.md の
	// interval_presets 節を参照）。ここでは値の中身を検証しない
	readonly intervals: readonly Hours[];
}

// システム標準プリセット。固定 slug の id で管理する（crypto.randomUUID() のような
// ランダム id だと環境ごとに id がずれ、アプリ側が安定して参照できない。
// docs/schema.md の interval_presets 節を参照）。
// `system-standard` の値は #14（packages/db/migrations/0006_seed_system_interval_preset.sql）で
// すでに本番投入済みのため変更しない。
export const SYSTEM_INTERVAL_PRESETS: readonly IntervalPreset[] = [
	{ id: 'system-short', name: '短期集中', intervals: [1, 6, 24, 72] },
	{ id: 'system-standard', name: '標準', intervals: [1, 24, 72, 168, 336, 720] },
	{ id: 'system-long', name: '長期', intervals: [24, 168, 720, 2160] }
];

// 将来 SM-2 / FSRS 等のアルゴリズムを差し込めるようにするための最小のインターフェース（#29）。
// SM-2 / FSRS は自己評価等の追加入力を要するため、そのままでは実装を差し込めない可能性がある
// （#29 側で「そうなっていなければ、まずリファクタリングする」と明記されている）。
export interface SchedulingStrategy {
	nextReviewAt(baseTime: Date, intervals: readonly Hours[], step: number): Date | undefined;
}

// 次の復習時刻を計算する。UTC 絶対時刻（epoch ms）への加算のみで計算するため、
// タイムゾーンや夏時間、カレンダー上の月境界の影響を受けない。
// intervals は時間単位（例: [1, 6, 24, 72]）で、月・日といったカレンダー単位の概念を持たない
// （例えば 30日相当の間隔は 720 として表現され、「1/31 の1ヶ月後」であっても
// 常に baseTime + 720時間 になる。カレンダー上の「1ヶ月後」にはならない）。
//
// step は intervals の 0 始まりインデックス（reviews.step と同じ意味、docs/schema.md 参照）。
// step が範囲外（全ステップ完了後、または負数・非整数などの異常な値）の場合は
// undefined を返す。全ステップ完了後に undefined を返す（最終間隔を繰り返さない）のは、
// reviews がメモ作成時に全ステップ分を一括生成する方針（docs/schema.md の reviews 節）と
// 整合させるための決定であり、繰り返し方式は一括生成と構造的に噛み合わない。
// intervals が空配列の場合も同様に、どの step でも undefined を返す
// （intervals 自体の妥当性検証は #18 の責務であり、ここでは行わない）。
export function nextReviewAt(
	baseTime: Date,
	intervals: readonly Hours[],
	step: number
): Date | undefined {
	const hours = intervals[step];
	if (hours === undefined) return undefined;
	return new Date(baseTime.getTime() + hours * 60 * 60 * 1000);
}

export const fixedIntervalStrategy: SchedulingStrategy = { nextReviewAt };
