import { redirect } from '@sveltejs/kit';
import { toSafeRedirect } from '$lib/server/safe-redirect';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const redirectTo = toSafeRedirect(url.searchParams.get('redirectTo'), '/app');

	if (locals.user) {
		redirect(303, redirectTo);
	}

	return { redirectTo };
};
