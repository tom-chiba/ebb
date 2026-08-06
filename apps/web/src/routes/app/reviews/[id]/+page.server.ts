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
			review: { id: review.id, memoTitle: review.memoTitle },
			renderedContent: renderMarkdown(review.memoContent)
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
			// 完了直後の一覧はこの review が消えた状態になるため、offset を維持すると
			// 後続の行がひとつずつ前にずれて表示がスキップされうる。素の一覧 URL に戻す。
			const params = new URLSearchParams({ completedTitle: result.memoTitle });
			if (result.nextScheduledAt) {
				params.set('nextScheduledAt', result.nextScheduledAt.toISOString());
			}
			redirect(303, `/app/reviews?${params.toString()}`);
		} catch (err) {
			handleDomainError(err);
		}
	}
};
