<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let statusMessage = $state('');

	async function signInWithGoogle() {
		statusMessage = 'Google へリダイレクト中...';
		const { error: err } = await authClient.signIn.social({
			provider: 'google',
			callbackURL: '/debug/auth'
		});
		if (err) {
			statusMessage = `失敗: ${err.message ?? JSON.stringify(err)}`;
		}
	}

	async function signOut() {
		statusMessage = 'サインアウト中...';
		const { error: err } = await authClient.signOut();
		if (err) {
			statusMessage = `失敗: ${err.message ?? JSON.stringify(err)}`;
			return;
		}
		location.reload();
	}
</script>

<h2>Better Auth 検証 (#10)</h2>

{#if data.user}
	<p>ログイン中: {data.user.email}</p>
	<pre>{JSON.stringify(data.user, null, 2)}</pre>
	<button onclick={signOut}>サインアウト</button>
{:else}
	<p>未ログイン</p>
	<button onclick={signInWithGoogle}>Google でサインイン</button>
{/if}

<p>{statusMessage}</p>
