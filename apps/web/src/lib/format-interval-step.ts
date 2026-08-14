// 1つの間隔ステップ（時間単位の数値）を「n 時間後」「n 日後」の表示に変換する。
// 24で割り切れるかどうかで単位を機械的に決める（@ebb/core の formatIntervals と
// 同じ規則）。IntervalStepEditor（ステップ一覧・追加中のステップ表示）と
// プリセット編集の差分表示（変更前後それぞれのステップ）の両方で使う。
export function formatIntervalStep(hours: number): string {
	return hours % 24 === 0 ? `${hours / 24} 日後` : `${hours} 時間後`;
}
