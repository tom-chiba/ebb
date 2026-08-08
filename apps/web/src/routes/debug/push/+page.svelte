<script lang="ts">
	import { enhance } from '$app/forms';
	import { urlBase64ToUint8Array } from '$lib/push-subscribe';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let subscriptionJson = $state('');
	let statusMessage = $state('');

	async function subscribe() {
		try {
			statusMessage = 'Service Worker を登録中...';
			// 現状の src/service-worker.ts は import/export を持たないため本番ビルドでは
			// classic 出力になるが、このデバッグページでは明示的に ESM として登録する
			const registration = await navigator.serviceWorker.register('/service-worker.js', {
				type: 'module'
			});
			await navigator.serviceWorker.ready;

			// applicationServerKey が変わらない限り、既存の購読があれば subscribe() は
			// それをそのまま返す（unsubscribe を挟むと新規購読失敗時に復元できなくなる）
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(data.vapidPublicKey)
			});

			subscriptionJson = JSON.stringify(subscription.toJSON(), null, 2);
			statusMessage = '購読完了。endpoint を確認できる';
		} catch (err) {
			statusMessage = `失敗: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
</script>

<h2>Web Push 検証 (#8)</h2>

<p>
	<button onclick={subscribe}>購読する</button>
	{statusMessage}
</p>

<form method="POST" action="?/send" use:enhance>
	<textarea name="subscription" bind:value={subscriptionJson} rows="8" cols="100"></textarea>
	<br />
	<button type="submit" disabled={!subscriptionJson}>テスト通知を送信する</button>
</form>

{#if form}
	<pre>{JSON.stringify(form, null, 2)}</pre>
{/if}
