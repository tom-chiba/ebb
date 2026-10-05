import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// 復習一覧は `/`（復習タブ）に一本化した（#94）。ブックマーク・既存リンク向けに残す。
// 将来この URL を別用途に使い直せるよう、ブラウザにキャッシュされる恒久リダイレクトにはしない。
export const load: PageServerLoad = () => {
	redirect(307, '/');
};
