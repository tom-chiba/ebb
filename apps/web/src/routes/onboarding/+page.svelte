<script lang="ts">
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { detectPlatform, type PlatformInfo } from '$lib/platform-detect';
	import { requestPushSubscription } from '$lib/push-subscribe';
	import Button from '$lib/components/Button.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// SSR では判定できない（navigator/window が無い）ため、まず null（確認中）で
	// レンダリングし、onMount で確定させる（settings ページの permissionState と同じ考え方）。
	let platform: PlatformInfo | null = $state(null);
	let subscribeBusy = $state(false);
	let subscribed = $state(false);
	let statusMessage = $state('');

	onMount(() => {
		platform = detectPlatform();
	});

	async function submitSubscription(subscription: PushSubscription): Promise<boolean> {
		const json = subscription.toJSON();
		if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
			throw new Error('購読情報の取得に失敗しました');
		}
		const body = new FormData();
		body.set('endpoint', json.endpoint);
		body.set('p256dh', json.keys.p256dh);
		body.set('auth', json.keys.auth);
		const response = await fetch('?/subscribePush', { method: 'POST', body });
		const result = deserialize(await response.text());
		return result.type === 'success';
	}

	// 許可ダイアログはこのボタンを押したときにだけ出す（#19 の注意事項と同じ）。
	async function enableNotifications() {
		if (!data.vapidPublicKey) return;
		subscribeBusy = true;
		statusMessage = '';
		try {
			const subscription = await requestPushSubscription(data.vapidPublicKey);
			if (!subscription) {
				statusMessage = '通知が許可されませんでした。あとで設定画面から有効にできます。';
				return;
			}
			if (await submitSubscription(subscription)) {
				subscribed = true;
			} else {
				statusMessage = 'サーバーへの保存に失敗しました。もう一度お試しください。';
			}
		} catch (err) {
			statusMessage = `失敗しました: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			subscribeBusy = false;
		}
	}
</script>

<div class="onboarding">
	<div class="brand">
		<div class="logo-mark"></div>
		<h1>Ebbへようこそ</h1>
		<p class="copy">
			書いたメモを、忘れかけた頃に届けます。1時間後、1日後、3日後 —
			通知を受け取れるようにしておくと、届いたタイミングを逃しません。
		</p>
	</div>

	{#if platform === null}
		<p class="hint">確認中…</p>
	{:else if platform.isIOSLike && !platform.isStandalone}
		<div class="guide">
			<p class="guide-title">iPhone・iPad では、ホーム画面に追加すると通知を受け取れます</p>
			<ol>
				<li>画面下（または上）の共有アイコンをタップ</li>
				<li>「ホーム画面に追加」を選ぶ</li>
				<li>追加されたアイコンから開き直す</li>
			</ol>
			<p class="hint">開き直すと、このページに通知を有効にするボタンが表示されます。</p>
		</div>
	{:else if !platform.pushCapable}
		<p class="hint">このブラウザは通知に対応していません。あとで設定画面から確認できます。</p>
	{:else}
		<div class="guide">
			{#if platform.isAndroid && !platform.isStandalone}
				<p class="hint">
					ブラウザのメニューから「アプリをインストール」を選ぶと、ホーム画面からアプリのように
					開けます（必須ではありません）。
				</p>
			{/if}
			{#if subscribed}
				<p class="hint">通知を有効にしました。</p>
			{:else}
				<Button variant="primary" disabled={subscribeBusy} onclick={enableNotifications}>
					通知を有効にする
				</Button>
			{/if}
			{#if statusMessage}
				<p class="error">{statusMessage}</p>
			{/if}
		</div>
	{/if}

	<form method="POST" action="?/finish" class="finish-form">
		<Button variant={subscribed ? 'primary' : 'quiet'} type="submit">
			{subscribed ? 'はじめる' : 'スキップ'}
		</Button>
	</form>
</div>

<style>
	.onboarding {
		min-height: 100dvh;
		max-width: 480px;
		margin: 0 auto;
		padding: 0 2rem;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1.5rem;
	}

	.brand {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
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

	.guide {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.guide-title {
		font-size: var(--text-body);
		font-weight: 500;
		color: var(--color-text);
		margin: 0;
	}

	.guide ol {
		margin: 0;
		padding-left: 1.25rem;
		font-size: var(--text-small);
		line-height: 1.9;
		color: var(--color-text-muted);
	}

	.hint {
		font-size: var(--text-caption);
		line-height: 1.8;
		color: var(--color-text-caption);
		margin: 0;
	}

	.error {
		font-size: var(--text-caption);
		color: var(--color-error);
		margin: 0;
	}

	.finish-form {
		display: flex;
	}
</style>
