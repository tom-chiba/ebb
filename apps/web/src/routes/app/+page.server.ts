import { requireAuthedDb } from '$lib/server/api';
import { listDueReviews } from '$lib/server/reviews';
import type { PageServerLoad } from './$types';

// ホームは抜粋のみを見せるプレビューなので、全件は listDueReviews の呼び出し元
// である /app/reviews（もっと見るの遷移先）に任せる。
const HOME_ITEMS_LIMIT = 5;

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);

	const result = await listDueReviews(db, user.id, { limit: HOME_ITEMS_LIMIT, offset: 0 });

	// /app/reviews/+page.server.ts と同じ理由・同じ方式（302 の宛先 URL に載せるだけの
	// 直前の復習完了結果のフラッシュ表示）。ホーム発の復習完了は
	// /app/reviews/[id]/+page.server.ts の complete アクションが from=home のときに
	// ここへリダイレクトすることで届く。
	const completedTitle = event.url.searchParams.get('completedTitle');
	const nextScheduledAtParam = event.url.searchParams.get('nextScheduledAt');
	const parsedNextScheduledAt = nextScheduledAtParam ? new Date(nextScheduledAtParam) : null;
	const nextScheduledAt =
		parsedNextScheduledAt && !Number.isNaN(parsedNextScheduledAt.getTime())
			? parsedNextScheduledAt
			: null;

	return {
		items: result.items,
		total: result.total,
		completedTitle,
		nextScheduledAt
	};
};
