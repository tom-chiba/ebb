import { MAX_INTERVAL_COUNT } from '@ebb/core';
import { fail, redirect } from '@sveltejs/kit';
import { requireAuthedDb } from '$lib/server/api';
import { presetActionFail } from '$lib/server/action-errors';
import { createCustomPreset, PRESET_NAME_MAX_LENGTH } from '$lib/server/interval-presets';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return {
		maxIntervalCount: MAX_INTERVAL_COUNT,
		presetNameMaxLength: PRESET_NAME_MAX_LENGTH
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { user, db } = requireAuthedDb(event);
		const form = await event.request.formData();
		const name = form.get('name');
		const intervals = form.get('intervals');
		if (typeof name !== 'string' || typeof intervals !== 'string') {
			return fail(400, {
				message: '入力が不正です',
				name: typeof name === 'string' ? name : '',
				intervals: typeof intervals === 'string' ? intervals : ''
			});
		}
		try {
			await createCustomPreset(db, user.id, name, intervals);
		} catch (err) {
			return presetActionFail(err, 'createPreset', { name, intervals });
		}
		redirect(303, '/settings');
	}
};
