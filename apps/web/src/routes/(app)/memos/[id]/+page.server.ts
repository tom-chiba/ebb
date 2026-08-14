import { redirect } from '@sveltejs/kit';
import { formatIntervals } from '@ebb/core';
import { requireAuthedDb } from '$lib/server/api';
import { handleDomainError } from '$lib/server/errors';
import { getPresetNameAndIntervals } from '$lib/server/interval-presets';
import { renderMarkdown } from '$lib/server/markdown';
import { archiveMemo, getMemo } from '$lib/server/memos';
import { listReviewSchedule } from '$lib/server/reviews';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const memo = await getMemo(db, user.id, event.params.id);
		const [preset, schedule] = await Promise.all([
			getPresetNameAndIntervals(db, memo.intervalPresetId),
			listReviewSchedule(db, memo.id)
		]);

		// 常に最小の未完了 step からのみ完了させる不変条件（apps/web/src/lib/server/reviews.ts
		// の assertIsCurrentStep と同じ前提）により、未完了行のうち step が最小のものが
		// 「次回予定」として強調すべき行になる。全行が完了済みなら該当なし（= 復習完了）。
		// メモ一覧側（apps/web/src/lib/server/reviews.ts の minPendingScheduledAtSubquery、
		// min(scheduledAt) で同じ行を選ぶ）とは判定方法が異なる（min(step) vs
		// min(scheduledAt)）。通常は一致するが、プリセット切替後の再アンカリング未実施
		// （#18 スコープ）が絡む場合は一致しないことがある。詳細は
		// minPendingScheduledAtSubquery のコメントを参照。
		const nextStep = schedule.find((row) => row.completedAt === null);

		return {
			memo: { id: memo.id, title: memo.title },
			renderedContent: renderMarkdown(memo.content),
			presetName: preset?.name ?? '',
			presetIntervalsText: preset ? formatIntervals(preset.intervals) : '',
			nextScheduledAt: nextStep?.scheduledAt ?? null,
			schedule: schedule.map((row) => {
				// プリセット編集（#18）は未完了 reviews を作り直すため、完了済みステップの
				// intervals[step] は既にプリセット側から消えている／別の値になっていることが
				// ある（apps/web/src/lib/server/reviews.ts の getDueReviewDetail と同じ理由）。
				// ラベルはあくまで表示上の補足なので、範囲外なら「n 回目」にフォールバックする。
				const intervalHours = preset?.intervals[row.step];
				return {
					step: row.step,
					label:
						intervalHours !== undefined
							? `${formatIntervals([intervalHours])} 後`
							: `${row.step + 1} 回目`,
					scheduledAt: row.scheduledAt,
					completedAt: row.completedAt,
					isNext: nextStep?.step === row.step
				};
			})
		};
	} catch (err) {
		handleDomainError(err);
	}
};

export const actions: Actions = {
	delete: async (event) => {
		const { user, db } = requireAuthedDb(event);
		try {
			await archiveMemo(db, user.id, event.params.id);
		} catch (err) {
			handleDomainError(err);
		}
		redirect(303, '/memos');
	}
};
