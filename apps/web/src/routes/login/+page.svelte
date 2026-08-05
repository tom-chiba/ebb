<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let statusMessage = $state('');

	async function signInWithGoogle() {
		statusMessage = 'Google へリダイレクト中...';
		const { error: err } = await authClient.signIn.social({
			provider: 'google',
			callbackURL: data.redirectTo
		});
		if (err) {
			statusMessage = `失敗: ${err.message ?? JSON.stringify(err)}`;
		}
	}
</script>

<h1>ログイン</h1>
<button onclick={signInWithGoogle}>Google でログイン</button>
<p>{statusMessage}</p>
