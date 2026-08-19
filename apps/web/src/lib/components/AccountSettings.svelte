<script lang="ts">
	import { authClient } from '$lib/auth-client';
	import Button from './Button.svelte';

	let { userName }: { userName: string } = $props();

	let accountStatusMessage = $state('');

	async function signOut() {
		const { error: err } = await authClient.signOut();
		if (err) {
			accountStatusMessage = `ログアウトに失敗しました: ${err.message ?? JSON.stringify(err)}`;
			return;
		}
		location.reload();
	}
</script>

<div class="section">
	<div class="section-label">アカウント</div>
	<div class="account">
		<span>{userName}</span>
		<Button variant="quiet" onclick={signOut}>ログアウト</Button>
	</div>
	{#if accountStatusMessage}
		<p class="error">{accountStatusMessage}</p>
	{/if}
</div>

<style>
	.section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.section-label {
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.account {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}
</style>
