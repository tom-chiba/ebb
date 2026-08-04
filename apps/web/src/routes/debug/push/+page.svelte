<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let subscriptionJson = $state('');
	let statusMessage = $state('');

	function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
		const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
		const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(base64);
		// atob 直後の文字列長からアロケートすると Uint8Array<ArrayBuffer> になる
		// （Uint8Array.from は ArrayBufferLike のままで applicationServerKey の型に合わない）
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) {
			bytes[i] = raw.charCodeAt(i);
		}
		return bytes;
	}

	async function subscribe() {
		try {
			statusMessage = 'Service Worker を登録中...';
			// dev/build ともに ESM で出力されるため type: 'module' が必要
			const registration = await navigator.serviceWorker.register('/service-worker.js', {
				type: 'module',
			});
			await navigator.serviceWorker.ready;

			const existing = await registration.pushManager.getSubscription();
			if (existing) {
				await existing.unsubscribe();
			}

			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(data.vapidPublicKey),
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
