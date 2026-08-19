<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import {
		postFormAction,
		requestPushSubscription,
		submitPushSubscription
	} from '$lib/push-subscribe';

	let { vapidPublicKey }: { vapidPublicKey: string | null } = $props();

	type PermissionState = NotificationPermission | 'unsupported' | 'checking';

	let permissionState: PermissionState = $state('checking');
	let subscribed = $state(false);
	let pushBusy = $state(false);
	let pushStatusMessage = $state('');

	// ページ表示時は、ブラウザの endpoint が現在ユーザーのものとして保存済みかを
	// 読み取るだけにする。共有端末で別アカウントへ切り替えた場合の所有権付け替えは、
	// そのユーザーが「通知を有効にする」を明示的に押したときにだけ行う。
	async function checkSubscriptionOwnership(endpoint: string): Promise<boolean> {
		const body = new FormData();
		body.set('endpoint', endpoint);
		const result = await postFormAction('?/checkPushSubscription', body);
		return (
			result.type === 'success' &&
			result.data !== undefined &&
			'subscribed' in result.data &&
			result.data.subscribed === true
		);
	}

	// ネットワーク失敗時は「有効」と誤表示しない方向へ倒し、静かに未購読扱いにする。
	async function refreshSubscriptionState() {
		if (!vapidPublicKey) return;
		if (typeof Notification === 'undefined') {
			permissionState = 'unsupported';
			return;
		}
		permissionState = Notification.permission;
		if (permissionState !== 'granted') {
			subscribed = false;
			return;
		}
		const registration = await navigator.serviceWorker.ready;
		const subscription = await registration.pushManager.getSubscription();
		if (!subscription) {
			subscribed = false;
			return;
		}
		try {
			subscribed = await checkSubscriptionOwnership(subscription.endpoint);
		} catch {
			subscribed = false;
		}
	}

	onMount(() => {
		refreshSubscriptionState();
	});

	// トグルスイッチ下に表示する状態説明。許可状態の遷移ロジック自体は変えず、
	// 見た目をボタンからトグルに変えたことに伴う文言の出し分けのみ担う。
	let notificationDescription = $derived.by(() => {
		switch (permissionState) {
			case 'checking':
				return '確認中…';
			case 'default':
				return '許可すると、復習の期限が来たら届きます';
			case 'denied':
				return 'ブロックされています';
			case 'granted':
				return subscribed ? '許可済み ・ 復習の期限が来たら届きます' : 'この端末では無効です';
			case 'unsupported':
				return '';
		}
	});

	// 許可ダイアログはユーザーがこのボタンを押したときにだけ出す
	// （ページ表示直後に出すと拒否されやすいため。issue #19 の注意事項）。
	async function enableNotifications() {
		if (!vapidPublicKey) {
			pushStatusMessage = '現在この環境では通知を利用できません。';
			return;
		}
		pushBusy = true;
		pushStatusMessage = '';
		try {
			const subscription = await requestPushSubscription(vapidPublicKey);
			permissionState = Notification.permission;
			if (!subscription) {
				pushStatusMessage = '通知が許可されませんでした。';
				return;
			}

			if (await submitPushSubscription('?/subscribePush', subscription)) {
				subscribed = true;
				pushStatusMessage = '通知を有効にしました。';
			} else {
				pushStatusMessage = 'サーバーへの保存に失敗しました。もう一度お試しください。';
			}
		} catch (err) {
			pushStatusMessage = `失敗しました: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			pushBusy = false;
		}
	}

	// サーバー側のレコード削除が先に成功した場合のみブラウザ側を unsubscribe する
	// （理由は $lib/server/push-subscriptions.ts の deletePushSubscription を参照）。
	// 対象行が存在しない場合もサーバー側は成功を返すため、else 分岐に到達するのは
	// 真に予期しない失敗のときだけになる。
	async function disableNotifications() {
		pushBusy = true;
		pushStatusMessage = '';
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				subscribed = false;
				return;
			}

			const body = new FormData();
			body.set('endpoint', subscription.endpoint);
			const result = await postFormAction('?/unsubscribePush', body);
			if (result.type === 'success') {
				await subscription.unsubscribe();
				subscribed = false;
				pushStatusMessage = '通知を無効にしました。';
			} else {
				pushStatusMessage = 'サーバーからの削除に失敗しました。もう一度お試しください。';
			}
		} catch (err) {
			pushStatusMessage = `失敗しました: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			pushBusy = false;
		}
	}
</script>

<div class="section">
	<div class="section-label">通知</div>
	{#if !vapidPublicKey}
		<p class="hint">現在この環境では通知を利用できません。</p>
	{:else if permissionState === 'unsupported'}
		<p class="hint">このブラウザは通知に対応していません。</p>
	{:else}
		<div class="toggle-row">
			<div class="toggle-text">
				<span class="toggle-title">この端末で通知を受け取る</span>
				<span class="toggle-desc">{notificationDescription}</span>
			</div>
			<button
				type="button"
				class="toggle-switch"
				class:on={subscribed}
				role="switch"
				aria-checked={subscribed}
				aria-label="この端末で通知を受け取る"
				disabled={pushBusy || permissionState === 'checking' || permissionState === 'denied'}
				onclick={() => (subscribed ? disableNotifications() : enableNotifications())}
			>
				<span class="toggle-knob"></span>
			</button>
		</div>
		{#if permissionState === 'denied'}
			<p class="error">
				通知がブロックされています。ブラウザのサイト設定（アドレスバー付近の鍵アイコンなど）から
				このサイトの通知を許可に変更し、ページを再読み込みしてください。
			</p>
		{/if}
	{/if}
	{#if pushStatusMessage}
		<p class="hint">{pushStatusMessage}</p>
	{/if}
	<p class="onboarding-link">
		<a href={resolve('/onboarding')}>使い方・ホーム画面への追加案内をもう一度見る</a>
	</p>
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

	.hint {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--color-text-muted);
	}

	.toggle-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.875rem;
	}

	.toggle-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.toggle-title {
		font-size: var(--text-body);
		font-weight: 500;
		color: var(--color-text);
	}

	.toggle-desc {
		font-size: var(--text-caption);
		line-height: 1.6;
		color: var(--color-text-muted);
	}

	.toggle-switch {
		flex: none;
		position: relative;
		width: 48px;
		height: 29px;
		border: none;
		border-radius: 15px;
		background: var(--color-border-strong);
		padding: 0;
		cursor: pointer;
	}

	.toggle-switch.on {
		background: var(--color-accent);
	}

	.toggle-switch:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.toggle-switch:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.toggle-knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 23px;
		height: 23px;
		border-radius: 50%;
		background: var(--color-surface-card);
		transition: left 0.15s ease;
	}

	.toggle-switch.on .toggle-knob {
		left: 22px;
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}

	.onboarding-link {
		margin: 0;
		font-size: var(--text-caption);
	}

	.onboarding-link a {
		color: var(--color-accent);
	}
</style>
