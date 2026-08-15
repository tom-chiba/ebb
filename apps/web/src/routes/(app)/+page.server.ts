import { redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { hasSeenOnboarding } from '$lib/server/onboarding';
import { listDueReviews } from '$lib/server/reviews';
import type { PageServerLoad } from './$types';

// ホームは抜粋のみを見せるプレビューなので、全件は listDueReviews の呼び出し元
// である /reviews（もっと見るの遷移先）に任せる。
const HOME_ITEMS_LIMIT = 5;

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);

	// オンボーディング未対応の判定はここ（ログイン後の着地点）でのみ行う。
	// (app) グループの +layout.server.ts で全ページ共通にすると、クライアント側
	// 遷移のたびに D1 への SELECT が挟まり（Free プランの CPU 10ms/リクエスト制約に
	// 無関係な負荷を足すことになる）、かつ通知クリック等の深いリンク（/reviews/{id}）
	// から来たユーザーの遷移先を奪ってしまう（#24。docs/design-decisions.md 参照）。
	if (!(await hasSeenOnboarding(db, user.id))) {
		redirect(303, '/onboarding');
	}

	const result = await listDueReviews(db, user.id, { limit: HOME_ITEMS_LIMIT, offset: 0 });

	// /reviews/+page.server.ts と同じ理由・同じ方式（302 の宛先 URL に載せるだけの
	// 直前の復習完了結果のフラッシュ表示）。ホーム発の復習完了は
	// /reviews/[id]/+page.server.ts の complete アクションが from=home のときに
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
		nextScheduledAt,
		// 通知が無効なまま使っているユーザーへの控えめなリマインド（#24）表示可否の判定に使う。
		// settings/+page.server.ts と同じ理由で null 許容にする。
		vapidPublicKey: event.platform?.env.VAPID_PUBLIC_KEY ?? null
	};
};
