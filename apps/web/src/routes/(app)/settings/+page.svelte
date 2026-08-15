<script lang="ts">
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { resolve } from '$app/paths';
	import { authClient } from '$lib/auth-client';
	import { urlBase64ToUint8Array } from '$lib/push-subscribe';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeading from '$lib/components/PageHeading.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type PermissionState = NotificationPermission | 'unsupported' | 'checking';

	let permissionState: PermissionState = $state('checking');
	let subscribed = $state(false);
	let pushBusy = $state(false);
	let pushStatusMessage = $state('');
	let accountStatusMessage = $state('');

	async function signOut() {
		const { error: err } = await authClient.signOut();
		if (err) {
			accountStatusMessage = `ログアウトに失敗しました: ${err.message ?? JSON.stringify(err)}`;
			return;
		}
		location.reload();
	}

	// pushManager.subscribe() が返した購読を ?/subscribePush へ保存する。成功時は
	// true を返す。savePushSubscription は endpoint に対する upsert
	// （$lib/server/push-subscriptions.ts 参照）のため、この呼び出しは常に
	// 「今ログイン中のユーザーがこの endpoint の所有者になる」ことを意味する。
	// このページでは SvelteKit の `form` プロパティ（プリセット系フォームの表示制御に
	// のみ使用）を push 系の結果表示には使わず、`pushStatusMessage`/`subscribed` で
	// 独自に状態を持っているため、`applyAction` は呼ばない。`applyAction` は
	// `type: 'error'`（未処理例外による500）の結果を最寄りのエラーページへの
	// 全画面遷移として扱うため、ここで呼ぶと `refreshSubscriptionState` からの
	// バックグラウンド呼び出し（ユーザー操作なしで onMount から実行される）が
	// サーバー側の一時的な失敗だけで設定画面全体をエラーページに差し替えてしまう
	// （正確性レビューで指摘）。
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

	// ページ表示時は、ブラウザの endpoint が現在ユーザーのものとして保存済みかを
	// 読み取るだけにする。共有端末で別アカウントへ切り替えた場合の所有権付け替えは、
	// そのユーザーが「通知を有効にする」を明示的に押したときにだけ行う。
	async function checkSubscriptionOwnership(endpoint: string): Promise<boolean> {
		const body = new FormData();
		body.set('endpoint', endpoint);
		const response = await fetch('?/checkPushSubscription', { method: 'POST', body });
		const result = deserialize(await response.text());
		return (
			result.type === 'success' &&
			result.data !== undefined &&
			'subscribed' in result.data &&
			result.data.subscribed === true
		);
	}

	// ネットワーク失敗時は「有効」と誤表示しない方向へ倒し、静かに未購読扱いにする。
	async function refreshSubscriptionState() {
		if (!data.vapidPublicKey) return;
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
		if (!data.vapidPublicKey) {
			pushStatusMessage = '現在この環境では通知を利用できません。';
			return;
		}
		pushBusy = true;
		pushStatusMessage = '';
		try {
			const permission = await Notification.requestPermission();
			permissionState = permission;
			if (permission !== 'granted') {
				pushStatusMessage = '通知が許可されませんでした。';
				return;
			}

			// SvelteKit がページ読み込み時に自動で Service Worker を登録するため、
			// ここでは登録済みのものを待つだけでよい（自前で register() は呼ばない。
			// docs/design-decisions.md の #9 節を参照）。
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(data.vapidPublicKey)
			});
			if (await submitSubscription(subscription)) {
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
			const response = await fetch('?/unsubscribePush', { method: 'POST', body });
			const result = deserialize(await response.text());
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

<PageHeading title="設定" />

<div class="cards">
	<Card>
		<div class="section">
			<div class="section-label">通知</div>
			{#if !data.vapidPublicKey}
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
		</div>
	</Card>

	<Card>
		<div class="section">
			<div class="section-label">新規メモの既定プリセット</div>
			<form method="POST" action="?/setDefault" class="option-list">
				{#each data.presets as preset (preset.id)}
					<label class="option-row">
						<input
							type="radio"
							name="presetId"
							value={preset.id}
							class="option-radio"
							checked={preset.id === data.defaultPresetId}
						/>
						<div class="option-text">
							<span class="option-name">{preset.name}</span>
							<span class="option-meta">{preset.intervalsText}</span>
						</div>
						<span class="option-dot" aria-hidden="true"></span>
					</label>
				{/each}
				<!-- 選択のたびに自動送信するとキーボードでの矢印キー操作のたびにページ全体が
			     遷移してしまう（use:enhanceを使っていないため）。選択と保存を分け、
			     JS無効環境でも同じボタンで完結するようにする。 -->
				<div class="save-default-row">
					<Button variant="compact" type="submit">保存</Button>
				</div>
			</form>
			{#if form && form.action === 'setDefault'}
				{#if 'success' in form && form.success}
					<Flash>既定プリセットを更新しました。</Flash>
				{:else if 'message' in form}
					<p class="error">{form.message}</p>
				{/if}
			{/if}
		</div>
	</Card>

	<Card>
		<div class="section">
			<div class="section-header">
				<div class="section-label">プリセット</div>
				<Button variant="compact" tone="neutral" href={resolve('/settings/presets/new')}
					>＋ 追加</Button
				>
			</div>
			<ul class="preset-list">
				{#each data.presets as preset (preset.id)}
					<li>
						{#if preset.isSystem}
							<div class="preset-row">
								<div class="option-text">
									<span class="option-name">{preset.name}</span>
									<span class="option-meta">{preset.intervalsText} ・ 編集できません</span>
								</div>
								<span class="badge">標準搭載</span>
							</div>
						{:else}
							<a
								href={resolve('/(app)/settings/presets/[id]/edit', { id: preset.id })}
								class="preset-row preset-row-link"
							>
								<div class="option-text">
									<span class="option-name">{preset.name}</span>
									<span class="option-meta"
										>{preset.intervalsText} ・ {preset.inUseCount}件のメモが参照中（アーカイブ済み含む）</span
									>
								</div>
								<span class="option-chevron" aria-hidden="true">›</span>
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</Card>

	<Card>
		<div class="section">
			<div class="section-label">アカウント</div>
			<div class="account">
				<span>{data.user.name}</span>
				<Button variant="quiet" onclick={signOut}>ログアウト</Button>
			</div>
			{#if accountStatusMessage}
				<p class="error">{accountStatusMessage}</p>
			{/if}
		</div>
	</Card>
</div>

<style>
	.cards {
		display: flex;
		flex-direction: column;
		gap: var(--space-stack);
	}

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

	.section-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.hint {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--color-text-muted);
	}

	/* 通知トグル */

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

	/* 既定プリセット・プリセット一覧 共通 */

	.option-list {
		gap: 0;
	}

	.save-default-row {
		margin-top: 0.75rem;
	}

	.option-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: var(--control-h-field);
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-border-subtle);
		cursor: pointer;
	}

	.option-list .option-row:last-child {
		border-bottom: none;
	}

	.option-radio {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}

	.option-text {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		flex: 1;
	}

	.option-name {
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.option-meta {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.option-dot {
		flex: none;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		border: 1.5px solid var(--color-border-strong);
	}

	.option-radio:checked ~ .option-dot {
		border-color: var(--color-accent);
		background: var(--color-accent);
		box-shadow: inset 0 0 0 2.5px var(--color-surface-card);
	}

	.option-radio:focus-visible ~ .option-dot {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.preset-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.preset-list li {
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.preset-list li:last-child {
		border-bottom: none;
	}

	.preset-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: var(--control-h-field);
		padding: 0.75rem 0;
	}

	.preset-row-link {
		color: inherit;
		text-decoration: none;
		cursor: pointer;
	}

	.preset-row-link:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.option-chevron {
		flex: none;
		font-size: var(--text-small);
		color: var(--color-text-faint);
	}

	.badge {
		flex: none;
		font-size: var(--text-caption);
		color: var(--color-text-muted);
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: 4px 10px;
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}

	.account {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
</style>
