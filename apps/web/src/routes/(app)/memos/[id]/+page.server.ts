import { redirect } from '@sveltejs/kit';
import { formatIntervals } from '@ebb/core';
import { requireAuthedDb } from '$lib/server/api';
import { handleDomainError } from '$lib/server/errors';
import { getPresetNameAndIntervals } from '$lib/server/interval-presets';
import { renderMarkdown } from '$lib/server/markdown';
import { archiveMemo, getMemo } from '$lib/server/memos';
import { getCurrentPendingReview, listReviewSchedule } from '$lib/server/reviews';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const memo = await getMemo(db, user.id, event.params.id);
		const [preset, schedule, currentReview] = await Promise.all([
			getPresetNameAndIntervals(db, memo.intervalPresetId),
			listReviewSchedule(db, memo.id),
			getCurrentPendingReview(db, memo.id)
		]);

		return {
			memo: { id: memo.id, title: memo.title },
			renderedContent: renderMarkdown(memo.content),
			presetName: preset?.name ?? '',
			presetIntervalsText: preset ? formatIntervals(preset.intervals) : '',
			nextScheduledAt: currentReview?.scheduledAt ?? null,
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
					isNext: currentReview?.step === row.step
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
