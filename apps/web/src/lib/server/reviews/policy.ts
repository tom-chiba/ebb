import { and, eq, exists, isNull, memos, reviewSchedules, sql, type Db } from '@ebb/db';
import { ConflictError } from '../errors';
import { getCurrentPendingReview } from './queries';

// 常に最小の未完了 step からのみ完了・閲覧できる（docs/schema.md が #17 に委ねた不変条件。
// #18 の再計算レシピが「完了済みステップ数を起点に」で成立することに依存している）。
// 一覧は常にこの条件を満たす行しか見せないため通常は到達しないが、review id を直接
// 指定した呼び出し（URL 直打ち等）に対する防御として、完了操作・詳細取得の両方で再検証する。
export async function assertIsCurrentStep(db: Db, memoId: string, step: number) {
	const current = await getCurrentPendingReview(db, memoId);
	if (current?.step !== step) {
		throw new ConflictError('an earlier review step must be completed first');
	}
}

// getDueReviewDetail（プレビュー）・completeReview（実際の記録）の両方が使う、
// 「次ステップの行が見つかった場合にどの日時を返すか」の決定ロジックの共通化
// （設計レビューで指摘）。次ステップの行が無ければ「このメモの復習は完了する」
// （null）。行があれば、再アンカリング計算（nextReviewAt）が済んでいればその新しい
// 日時を、計算できなかった（プリセット短縮等で intervals[step] が存在しない）場合は
// 既存の scheduledAt を返す（プリセット短縮時にも #17 の「対象ステップの完了」自体を
// 失敗させない、という completeReview の既存の前提と同じフォールバック）。
// 共有しているのはこのフォールバック処理のみ。「次ステップの行が存在するか」自体の
// クエリ・取得方法は、呼び出し元が必要とするデータの形が異なるため（completeReview は
// 再アンカリング計算のため残り全ステップの一覧が別途必要）、各関数で個別に行っている
// （設計レビューで指摘: コメントが実態より広く「判定ロジックを共有」と書いていたのを訂正）。
export function resolveNextScheduledAt(
	nextRow: { scheduledAt: Date } | undefined,
	reanchoredScheduledAt: Date | undefined
): Date | null {
	if (!nextRow) return null;
	return reanchoredScheduledAt ?? nextRow.scheduledAt;
}

// Issue #85: reviews への書き込み経路は、同じ論理操作内で review_schedules.version
// の CAS に勝った場合のみ書き込む、という不変条件を守るための共通ガード。version が
// 読み取り時のまま変わっていない（他の claim・completeReview がまだ割り込んで
// いない）ことを、review_schedules が FROM に無い文（reviews への DELETE 等）からも
// 使える形（EXISTS）で表す。列を直接 WHERE に混ぜると、その文が review_schedules を
// FROM/JOIN していない場合は「スコープに無い列」として SQL エラーになる（実測で確認、
// D1 が "no such column: review_schedules.memo_id" を返した）。
export function reviewScheduleVersionMatches(db: Db, memoId: string, expectedVersion: number) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(reviewSchedules)
			.where(and(eq(reviewSchedules.memoId, memoId), eq(reviewSchedules.version, expectedVersion)))
	);
}

// 対象メモが（このガード評価時点で）アーカイブされていないかを、同じ理由で EXISTS の
// 形で表す。アーカイブは一方向の操作（un-archive しない）のため、version の一致だけを
// 見ると「アーカイブ後に読み取った version」を「変化なし」と誤認し、アーカイブ済み
// メモの reviews を復活させてしまう（advisor 指摘）。
export function memoIsNotArchived(db: Db, memoId: string) {
	return exists(
		db
			.select({ one: sql`1` })
			.from(memos)
			.where(and(eq(memos.id, memoId), isNull(memos.archivedAt)))
	);
}
