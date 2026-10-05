import { redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { hasSeenOnboarding } from '$lib/server/onboarding';
import { parsePaginationParam } from '$lib/server/pagination';
import { listDueReviews } from '$lib/server/reviews';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 10;

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

	// 壊れた・改ざんされた offset はエラーにせず 1 ページ目へフォールバックする
	// （リンクを辿るだけの人間向けページのため。/memos と同じ方針）。
	const offsetParam = parsePaginationParam(event.url.searchParams.get('offset'));
	const offset = typeof offsetParam === 'number' ? offsetParam : 0;
	const result = await listDueReviews(db, user.id, { limit: PAGE_SIZE, offset });

	// 復習完了直後のフラッシュ表示。/reviews/[id]/+page.server.ts の complete アクションが
	// 302 の宛先 URL に載せるだけの単純な方式（セッション等は使わない）。
	// 通常経路では常に妥当な値だが、URL を手で書き換えられた場合に Invalid Date が
	// Intl.DateTimeFormat に渡って例外になるのを避ける。
	const completedTitle = event.url.searchParams.get('completedTitle');
	const nextScheduledAtParam = event.url.searchParams.get('nextScheduledAt');
	const parsedNextScheduledAt = nextScheduledAtParam ? new Date(nextScheduledAtParam) : null;
	const nextScheduledAt =
		parsedNextScheduledAt && !Number.isNaN(parsedNextScheduledAt.getTime())
			? parsedNextScheduledAt
			: null;

	return {
		...result,
		completedTitle,
		nextScheduledAt,
		// 通知が無効なまま使っているユーザーへの控えめなリマインド（#24）表示可否の判定に使う。
		// settings/+page.server.ts と同じ理由で null 許容にする。
		vapidPublicKey: event.platform?.env.VAPID_PUBLIC_KEY ?? null
	};
};
