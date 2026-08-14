// 復習間隔のプリセットと計算ロジック。DB にも Date.now() にも依存しない純粋関数として実装する。

export type Hours = number;

export interface IntervalPreset {
	readonly id: string;
	readonly name: string;
	// 時間単位の間隔配列。最小単位・順序のバリデーションは #18 の責務（docs/schema.md の
	// interval_presets 節を参照）。ここでは値の中身を検証しない
	readonly intervals: readonly Hours[];
}

// #18: カスタムプリセットの intervals に対するバリデーション制約。
export const MIN_INTERVAL_HOURS = 1;
// UI 上の任意の上限（issue 本文が具体的な数を指定していないため、既存のシステム
// プリセット最長（6ステップ）に十分な余裕を持たせた値を採用した）。
export const MAX_INTERVAL_COUNT = 20;
// 10年分（365 * 24 * 10）。上限を設けない場合、`baseTime.getTime() + hours * 3600000`
// が JS の Date の表現可能範囲（epoch から約 ±8.64e15ms）を超えて Invalid Date になり、
// それが NOT NULL の reviews.scheduledAt へそのまま INSERT されてしまう
// （正確性レビューで指摘）。10年は「間隔反復」という用途に対して十分に大きく、
// かつ Date のオーバーフローには全く近づかない安全な値として選んだ任意の上限。
export const MAX_INTERVAL_HOURS = 24 * 365 * 10;

// "1h, 12h, 2d, 10d" 形式の自由入力を時間単位の配列にパースし、その場で
// バリデーションする（最小1時間・整数・厳密昇順・重複禁止・要素数上限・空配列禁止）。
// 対応する単位は issue 本文の例に合わせて h（時間）/d（日、24時間）のみ。
// カレンダー単位（月等）は導入しない（docs/design-decisions.md の #15 節で intervals は
// カレンダー概念を持たないと確定済みのため、曖昧な "1ヶ月" 相当の単位は増やさない）。
// エラー時は Error を投げる（呼び出し側で ValidationError に変換する想定）。
export function parseIntervals(raw: string): number[] {
	const tokens = raw
		.split(',')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) {
		throw new Error('intervals must not be empty');
	}
	if (tokens.length > MAX_INTERVAL_COUNT) {
		throw new Error(`intervals must have at most ${MAX_INTERVAL_COUNT} steps`);
	}

	const intervals = tokens.map((token) => {
		const match = /^(\d+)(h|d)$/.exec(token);
		if (!match) {
			throw new Error(`"${token}" is not a valid interval (expected e.g. "1h" or "2d")`);
		}
		const [, amountStr, unit] = match;
		const amount = Number(amountStr);
		const hours = unit === 'd' ? amount * 24 : amount;
		if (hours < MIN_INTERVAL_HOURS) {
			throw new Error(`intervals must be at least ${MIN_INTERVAL_HOURS} hour`);
		}
		if (hours > MAX_INTERVAL_HOURS) {
			throw new Error(`intervals must be at most ${MAX_INTERVAL_HOURS} hours`);
		}
		return hours;
	});

	for (let i = 1; i < intervals.length; i++) {
		const prev = intervals[i - 1];
		const current = intervals[i];
		if (prev === undefined || current === undefined || current <= prev) {
			throw new Error('intervals must be in strictly ascending order');
		}
	}

	return intervals;
}

// parseIntervals の逆変換。24時間で割り切れる値は "d" 表記、それ以外は "h" 表記にする。
// 設定画面が保存済みの intervals を編集フォームへ表示し直す際、そのまま再送しても
// parseIntervals が同じ値を復元できることをテストで確認している（表示・入力の往復）。
export function formatIntervals(intervals: readonly Hours[]): string {
	return intervals.map((hours) => (hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`)).join(', ');
}

export type IntervalDiffStatus = 'unchanged' | 'changed' | 'added' | 'removed';

// status ごとに oldHours/newHours の有無が一意に決まる（unchanged/changed は両方必須、
// added は newHours のみ、removed は oldHours のみ）ため判別共用体にする。単一の
// interface で両方を `Hours | undefined` にすると、diffIntervals にバグがあり例えば
// changed エントリの newHours が欠けても型・実行時のどちらでも検知できず、消費側
// （表示コンポーネント）が `?? 0`（＝0時間後）のような不正なフォールバックを
// 書かざるを得なくなる。
export type IntervalDiffEntry =
	| { readonly status: 'unchanged'; readonly oldHours: Hours; readonly newHours: Hours }
	| { readonly status: 'changed'; readonly oldHours: Hours; readonly newHours: Hours }
	| { readonly status: 'added'; readonly newHours: Hours }
	| { readonly status: 'removed'; readonly oldHours: Hours };

// 既存プリセットの間隔編集で「変更前後の差分」を表示するための比較（#63）。
// 単純にインデックスどうしを比較すると、途中の1ステップを削除しただけで
// それ以降の全ステップが「値が変わった（changed）」と誤認識されてしまう
// （例: [1,24,72] → [1,72] は「24日後を削除した」だけなのに、末尾までの
// インデックスをずらして比較すると 24→72 の changed に見えてしまう）。
// intervals は常に厳密昇順・重複なし（parseIntervals が保証）なので、
// 両者に共通して現れる値（ソート済み配列の二分探索的な二本指走査で求まる、
// 最長共通部分列に相当するアンカー）を「動いていないステップ」の目印にし、
// アンカーとアンカーの間（＝どちらか一方にしか値がない区間）だけを
// 個別に処理する。区間内で削除候補・追加候補が両方あれば、同じ区間内での
// 「置き換え」とみなして先頭から順にペアリングし changed とする（ペアリング
// し切れず片方だけ余れば、その分だけ純粋な removed/added にする）。
export function diffIntervals(
	oldIntervals: readonly Hours[],
	newIntervals: readonly Hours[]
): IntervalDiffEntry[] {
	const entries: IntervalDiffEntry[] = [];

	// segment は「直前のアンカーから次のアンカー（またはどちらかの末尾）まで」の
	// 区間を、old側だけに残る値・new側だけに残る値の2本の配列として受け取る。
	function pushSegment(oldOnly: readonly Hours[], newOnly: readonly Hours[]): void {
		const pairCount = Math.min(oldOnly.length, newOnly.length);
		for (let i = 0; i < pairCount; i++) {
			entries.push({ status: 'changed', oldHours: oldOnly[i]!, newHours: newOnly[i]! });
		}
		for (let i = pairCount; i < oldOnly.length; i++) {
			entries.push({ status: 'removed', oldHours: oldOnly[i]! });
		}
		for (let i = pairCount; i < newOnly.length; i++) {
			entries.push({ status: 'added', newHours: newOnly[i]! });
		}
	}

	let oldIndex = 0;
	let newIndex = 0;
	let segmentOldStart = 0;
	let segmentNewStart = 0;
	// 両方とも厳密昇順なので、通常の二方向マージと同じ要領で共通値（アンカー）を
	// 見つけられる（一般の最長共通部分列のような総当たりは不要）。
	while (oldIndex < oldIntervals.length && newIndex < newIntervals.length) {
		const oldHours = oldIntervals[oldIndex];
		const newHours = newIntervals[newIndex];
		if (oldHours === newHours) {
			pushSegment(
				oldIntervals.slice(segmentOldStart, oldIndex),
				newIntervals.slice(segmentNewStart, newIndex)
			);
			// while 条件（oldIndex/newIndex とも各配列の長さ未満）で存在が保証されている。
			entries.push({ status: 'unchanged', oldHours: oldHours!, newHours: newHours! });
			oldIndex++;
			newIndex++;
			segmentOldStart = oldIndex;
			segmentNewStart = newIndex;
		} else if (oldHours! < newHours!) {
			oldIndex++;
		} else {
			newIndex++;
		}
	}
	pushSegment(oldIntervals.slice(segmentOldStart), newIntervals.slice(segmentNewStart));

	return entries;
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
