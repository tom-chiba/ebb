<script lang="ts">
	import { onMount } from 'svelte';
	import { applyAction, deserialize } from '$app/forms';
	import { urlBase64ToUint8Array } from '$lib/push-subscribe';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type PermissionState = NotificationPermission | 'unsupported';

	let permissionState: PermissionState = $state('default');
	let subscribed = $state(false);
	let pushBusy = $state(false);
	let pushStatusMessage = $state('');

	async function refreshSubscriptionState() {
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
		subscribed = (await registration.pushManager.getSubscription()) !== null;
	}

	onMount(() => {
		refreshSubscriptionState();
	});

	// 許可ダイアログはユーザーがこのボタンを押したときにだけ出す
	// （ページ表示直後に出すと拒否されやすいため。issue #19 の注意事項）。
	async function enableNotifications() {
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
			if (result.type === 'success') {
				subscribed = true;
				pushStatusMessage = '通知を有効にしました。';
			} else {
				pushStatusMessage = 'サーバーへの保存に失敗しました。もう一度お試しください。';
			}
			await applyAction(result);
		} catch (err) {
			pushStatusMessage = `失敗しました: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			pushBusy = false;
		}
	}

	// サーバー側のレコード削除が先に成功した場合のみブラウザ側を unsubscribe する。
	// 逆順だと、サーバー削除に失敗したときブラウザは既に購読解除済みで、
	// このユーザーはもう通知を受け取れないのに DB 上は購読中に見える不整合が残る
	// （advisor によるレビューで指摘。#20 未実装の現状、失効した購読の自動掃除手段が
	// ないため、失敗時は購読を残してユーザーに再試行させる方向を優先した）。
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
			await applyAction(result);
		} catch (err) {
			pushStatusMessage = `失敗しました: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			pushBusy = false;
		}
	}
</script>

<h1>設定</h1>

<section>
	<h2>通知</h2>
	{#if permissionState === 'unsupported'}
		<p>このブラウザは通知に対応していません。</p>
	{:else if permissionState === 'denied'}
		<p class="error">
			通知がブロックされています。ブラウザのサイト設定（アドレスバー付近の鍵アイコンなど）から
			このサイトの通知を許可に変更し、ページを再読み込みしてください。
		</p>
	{:else if subscribed}
		<p>この端末で通知が有効です。</p>
		<button onclick={disableNotifications} disabled={pushBusy}>通知を無効にする</button>
	{:else}
		<button onclick={enableNotifications} disabled={pushBusy}>通知を有効にする</button>
	{/if}
	{#if pushStatusMessage}
		<p>{pushStatusMessage}</p>
	{/if}
</section>

<section>
	<h2>新規メモの既定プリセット</h2>
	<form method="POST" action="?/setDefault">
		<label>
			既定プリセット
			<select name="presetId">
				{#each data.presets as preset (preset.id)}
					<option value={preset.id} selected={preset.id === data.defaultPresetId}>
						{preset.name}（{preset.intervalsText}）
					</option>
				{/each}
			</select>
		</label>
		<button type="submit">保存</button>
	</form>
	{#if form && form.action === 'setDefault'}
		{#if 'success' in form && form.success}
			<p class="flash">既定プリセットを更新しました。</p>
		{:else if 'message' in form}
			<p class="error">{form.message}</p>
		{/if}
	{/if}
</section>

<section>
	<h2>プリセット一覧</h2>
	<ul>
		{#each data.presets as preset (preset.id)}
			<li>
				<h3>
					{preset.name}{#if preset.isSystem}（システム標準）{/if}
				</h3>

				{#if preset.isSystem}
					<p>{preset.intervalsText}</p>
				{:else}
					{@const updateForm =
						form && form.action === 'updatePreset' && form.presetId === preset.id ? form : null}
					{@const previewing =
						updateForm !== null &&
						'previewCount' in updateForm &&
						!('success' in updateForm && updateForm.success)}
					<form method="POST" action="?/updatePreset">
						<input type="hidden" name="presetId" value={preset.id} />
						<label>
							間隔（例: 1h, 12h, 2d, 10d。最大{data.maxIntervalCount}件）
							<input
								type="text"
								name="intervals"
								value={updateForm && 'intervals' in updateForm
									? updateForm.intervals
									: preset.intervalsText}
							/>
						</label>

						{#if updateForm && 'success' in updateForm && updateForm.success}
							<p class="flash">{updateForm.updatedReviewsCount}件の予定を更新しました。</p>
						{:else if previewing && updateForm && 'previewCount' in updateForm}
							<p class="warning">
								{updateForm.previewCount}件の予定が更新されます。よろしいですか？
							</p>
							<input type="hidden" name="confirmed" value="true" />
						{:else if updateForm && 'message' in updateForm}
							<p class="error">{updateForm.message}</p>
						{/if}

						{#if previewing}
							<button type="submit">確定して更新する</button>
						{:else}
							<button type="submit">更新する</button>
						{/if}
					</form>

					<form method="POST" action="?/deletePreset">
						<input type="hidden" name="presetId" value={preset.id} />
						<button type="submit" disabled={preset.inUse}>削除</button>
					</form>
					{#if preset.inUse}
						<p>使用中のメモがあるため削除できません。</p>
					{/if}
					{#if form && form.action === 'deletePreset' && form.presetId === preset.id && 'message' in form}
						<p class="error">{form.message}</p>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
	{#if form && form.action === 'deletePreset' && 'success' in form && form.success}
		<p class="flash">プリセットを削除しました。</p>
	{/if}
</section>

<section>
	<h2>新しいプリセットを作る</h2>
	<form method="POST" action="?/createPreset">
		<label>
			名前
			<input
				type="text"
				name="name"
				value={form && form.action === 'createPreset' && 'name' in form ? form.name : ''}
				maxlength={data.presetNameMaxLength}
				required
			/>
		</label>
		<label>
			間隔（例: 1h, 12h, 2d, 10d。最大{data.maxIntervalCount}件）
			<input
				type="text"
				name="intervals"
				value={form && form.action === 'createPreset' && 'intervals' in form ? form.intervals : ''}
				required
			/>
		</label>
		<button type="submit">作成</button>
	</form>
	{#if form && form.action === 'createPreset'}
		{#if 'success' in form && form.success}
			<p class="flash">プリセットを作成しました。</p>
		{:else if 'message' in form}
			<p class="error">{form.message}</p>
		{/if}
	{/if}
</section>

<style>
	section {
		margin-bottom: 2rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 480px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	ul {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	li {
		border: 1px solid #ccc;
		border-radius: 8px;
		padding: 0.75rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.flash {
		background: #eef6ec;
		border: 1px solid #b8d8ae;
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.warning {
		background: #fdf3e5;
		border: 1px solid #e8c98a;
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.error {
		color: #b4562f;
	}
</style>
