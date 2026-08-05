import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!dev) {
		error(404, 'Not Found');
	}
	// session.token（認証用の値そのもの）を SSR ペイロードに乗せないよう、
	// このページが実際に表示する user だけを返す。
	return { user: locals.user };
};
