import { redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { handleDomainError } from '$lib/server/errors';
import { renderMarkdown } from '$lib/server/markdown';
import { completeReview, getDueReviewDetail } from '$lib/server/reviews';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);
	try {
		const review = await getDueReviewDetail(db, user.id, event.params.id);
		return {
			review: {
				id: review.id,
				memoTitle: review.memoTitle,
				step: review.step,
				totalSteps: review.totalSteps,
				previewNextScheduledAt: review.previewNextScheduledAt
			},
			renderedContent: renderMarkdown(review.memoContent),
			// ホームのカードから来た場合はここに from=home が付いており、完了後も
			// ホームへ戻す（下の complete アクション）。フォームの hidden input へ渡すため、
			// action="?/complete" が現在の検索文字列をまるごと置き換えて消えてしまう前に
			// ロード時点の値をそのまま保持しておく。
			from: event.url.searchParams.get('from')
		};
	} catch (err) {
		handleDomainError(err);
	}
};

export const actions: Actions = {
	complete: async (event) => {
		const { user, db } = requireAuthedDb(event);
		try {
			const result = await completeReview(db, user.id, event.params.id);
			const formData = await event.request.formData();
			const from = formData.get('from');
			// 完了直後の一覧はこの review が消えた状態になるため、offset を維持すると
			// 後続の行がひとつずつ前にずれて表示がスキップされうる。素の一覧 URL に戻す。
			const destination = from === 'home' ? '/app' : '/app/reviews';
			const params = new URLSearchParams({ completedTitle: result.memoTitle });
			if (result.nextScheduledAt) {
				params.set('nextScheduledAt', result.nextScheduledAt.toISOString());
			}
			redirect(303, `${destination}?${params.toString()}`);
		} catch (err) {
			handleDomainError(err);
		}
	}
};
