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

<div class="login">
	<div class="brand">
		<div class="logo-mark"></div>
		<h1>Ebb</h1>
		<p class="copy">
			書いたメモを、忘れかけた頃に届けます。<br />1時間後、1日後、3日後 —
			思い出すたびに記憶は残ります。
		</p>
	</div>
	<button type="button" class="google-button" onclick={signInWithGoogle}>Google でログイン</button>
	<p class="helper">ログイン後の案内に沿って、通知を有効にできます。</p>
	{#if statusMessage}
		<p class="status">{statusMessage}</p>
	{/if}
</div>

<style>
	.login {
		min-height: 100dvh;
		max-width: 480px;
		margin: 0 auto;
		padding: 0 2rem;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	.brand {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		margin-bottom: 2.5rem;
	}

	.logo-mark {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		background: var(--color-accent);
	}

	.brand h1 {
		font-size: 2.125rem;
		line-height: normal;
		letter-spacing: 0.01em;
		margin: 0;
	}

	.copy {
		font-size: 0.906rem;
		line-height: 1.95;
		color: var(--color-text-muted);
		margin: 0;
	}

	.google-button {
		height: 52px;
		width: 100%;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-pill);
		background: var(--color-surface-input);
		color: var(--color-text);
		font-family: var(--font-sans);
		font-size: 0.9375rem;
		font-weight: 500;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.625rem;
		cursor: pointer;
	}

	.helper {
		font-size: 0.719rem;
		line-height: 1.8;
		color: var(--color-text-caption);
		margin-top: 0.875rem;
		text-align: center;
	}

	.status {
		font-size: 0.8rem;
		color: var(--color-text-muted);
		text-align: center;
		margin-top: 0.75rem;
	}
</style>
