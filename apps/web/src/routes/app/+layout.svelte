<script lang="ts">
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	let statusMessage = $state('');

	async function signOut() {
		const { error: err } = await authClient.signOut();
		if (err) {
			statusMessage = `ログアウトに失敗しました: ${err.message ?? JSON.stringify(err)}`;
			return;
		}
		location.reload();
	}
</script>

<header>
	<nav>
		<a href={resolve('/app')}>ホーム</a>
		<a href={resolve('/app/memos')}>メモ</a>
	</nav>
	<span>{data.user.name}</span>
	<button onclick={signOut}>ログアウト</button>
</header>

{#if statusMessage}
	<p>{statusMessage}</p>
{/if}

{@render children()}

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #ccc;
	}

	nav {
		display: flex;
		gap: 1rem;
	}
</style>
