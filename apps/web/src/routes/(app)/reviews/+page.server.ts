import { requireAuthedDb } from '$lib/server/api';
import { parsePaginationParam } from '$lib/server/pagination';
import { listDueReviews } from '$lib/server/reviews';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 10;

export const load: PageServerLoad = async (event) => {
	const { user, db } = requireAuthedDb(event);

	// /memos/+page.server.ts と同じ理由で、壊れた・改ざんされた offset は
	// エラーにせず1ページ目へフォールバックする（リンクを辿るだけの人間向けページのため）。
	const offsetParam = parsePaginationParam(event.url.searchParams.get('offset'));
	const offset = typeof offsetParam === 'number' ? offsetParam : 0;

	const result = await listDueReviews(db, user.id, { limit: PAGE_SIZE, offset });

	// 復習完了後のリダイレクト（[id]/+page.server.ts の complete アクション）が
	// クエリパラメータで渡す、直前に完了した内容の表示用フラッシュメッセージ。
	// セッションストレージ等は使わず、302 の宛先 URL に載せるだけの単純な方式にした。
	const completedTitle = event.url.searchParams.get('completedTitle');
	const nextScheduledAtParam = event.url.searchParams.get('nextScheduledAt');
	// 通常経路では complete アクションが toISOString() した値のみが載るため常に妥当だが、
	// URL を手で書き換えられた場合に Invalid Date がそのままテンプレートの
	// Intl.DateTimeFormat に渡って例外になるのを避ける（offset の扱いと同じ方針）。
	const parsedNextScheduledAt = nextScheduledAtParam ? new Date(nextScheduledAtParam) : null;
	const nextScheduledAt =
		parsedNextScheduledAt && !Number.isNaN(parsedNextScheduledAt.getTime())
			? parsedNextScheduledAt
			: null;

	return {
		...result,
		completedTitle,
		nextScheduledAt
	};
};
