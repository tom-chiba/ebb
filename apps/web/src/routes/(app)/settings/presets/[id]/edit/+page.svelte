<script lang="ts">
	import { formatIntervals, parseIntervals } from '@ebb/core';
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import DangerZone from '$lib/components/DangerZone.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import IntervalStepEditor from '$lib/components/IntervalStepEditor.svelte';
	import { formatIntervalStep } from '$lib/format-interval-step';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	function safeParseIntervals(raw: string): number[] {
		try {
			return parseIntervals(raw);
		} catch {
			return [];
		}
	}

	let steps = $state(
		form && 'intervals' in form && typeof form.intervals === 'string'
			? safeParseIntervals(form.intervals)
			: [...data.preset.intervals]
	);

	const baseTime = new Date();
	const unchanged = $derived(formatIntervals(steps) === formatIntervals(data.preset.intervals));

	const updateSuccess = $derived(
		form?.action === 'update' && 'success' in form && form.success ? form : null
	);
	const updateError = $derived(
		form?.action === 'update' && !updateSuccess && 'message' in form ? form.message : null
	);
	const deleteError = $derived(
		form?.action === 'delete' && 'message' in form ? form.message : null
	);

	// previewCount/diff は「そのとき送信した intervals」に対する結果であり、
	// プレビュー表示後にステップを追加・削除・変更すると内容が一致しなくなる。
	// 一致しなくなった時点でプレビュー表示を引っ込め、確定前に必ず取り直させる
	// （そうしないと「見せた影響件数・差分」と異なる内容を確定してしまえる）。
	// テンプレート側で `'previewCount' in form`/`'diff' in form` を何度も
	// 書き直さずに済むよう、真偽値ではなく絞り込み済みの form 自体を保持する。
	const preview = $derived(
		form?.action === 'update' && 'previewCount' in form && formatIntervals(steps) === form.intervals
			? form
			: null
	);
</script>

<form method="POST" action="?/update">
	<input type="hidden" name="intervals" value={formatIntervals(steps)} />

	<div class="header">
		<a href={resolve('/settings')}>キャンセル</a>
		<div class="header-label">{data.preset.name}</div>
		{#if preview}
			<Button variant="compact" type="button" disabled>保存</Button>
		{:else}
			<Button
				variant="compact"
				type="submit"
				name="confirmed"
				value="false"
				disabled={steps.length === 0 || unchanged}>保存</Button
			>
		{/if}
	</div>

	<div class="fields">
		{#if updateSuccess}
			<Flash>{updateSuccess.updatedReviewsCount}件の予定を更新しました。</Flash>
			<a href={resolve('/settings')}>設定に戻る</a>
		{:else}
			{#if preview}
				<div class="impact-banner">
					<div class="impact-title">{preview.previewCount} 件の予定が更新されます</div>
					<p class="impact-desc">
						このプリセットを使っている未完了の復習予定が新しい間隔で作り直されます。完了済みの記録は変わりません。
					</p>
					<button type="submit" class="confirm-button" name="confirmed" value="true"
						>確定して更新する</button
					>
				</div>

				<div class="section">
					<span class="section-label">変更内容</span>
					<ul class="diff-list">
						{#each preview.diff as entry, index (index)}
							<li class="diff-row">
								<span class="diff-main" class:diff-highlight={entry.status !== 'unchanged'}>
									{#if entry.status === 'changed'}
										{formatIntervalStep(entry.oldHours)} → {formatIntervalStep(entry.newHours)}
									{:else if entry.status === 'added'}
										{formatIntervalStep(entry.newHours)}
									{:else}
										{formatIntervalStep(entry.oldHours)}
									{/if}
								</span>
								<span class="diff-status">
									{#if entry.status === 'unchanged'}
										変更なし
									{:else if entry.status === 'changed'}
										変更
									{:else if entry.status === 'added'}
										追加
									{:else}
										削除
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<IntervalStepEditor bind:steps maxIntervalCount={data.maxIntervalCount} {baseTime} />

			{#if updateError}
				<p class="error">{updateError}</p>
			{/if}
		{/if}
	</div>
</form>

<div class="fields">
	<div class="section">
		<span class="section-label">このプリセットを使っているメモ（アーカイブ済み含む）</span>
		{#if data.usedMemos.length > 0}
			<ul class="memo-list">
				{#each data.usedMemos as memo (memo.id)}
					<li>{memo.title}</li>
				{/each}
			</ul>
		{:else}
			<p class="hint">このプリセットを使っているメモはありません。</p>
		{/if}
	</div>

	<DangerZone>
		<form method="POST" action="?/delete" class="delete-form">
			<Button variant="quiet" type="submit" disabled={data.usedMemos.length > 0}
				>プリセットを削除</Button
			>
		</form>
		{#if data.usedMemos.length > 0}
			<p class="hint">使用中のメモがあるため削除できません。</p>
		{/if}
		{#if deleteError}
			<p class="error">{deleteError}</p>
		{/if}
	</DangerZone>
</div>

<style>
	form {
		display: flex;
		flex-direction: column;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 56px;
		box-sizing: border-box;
		padding: 0 var(--space-page);
		margin: 0 calc(var(--space-page) * -1);
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.header a {
		font-size: var(--text-small);
		color: var(--color-text-muted);
	}

	.header-label {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1rem 0;
	}

	.impact-banner {
		background: var(--color-warning-bg);
		border: 1px solid var(--color-warning-border);
		border-radius: var(--radius-card);
		padding: 0.875rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.impact-title {
		font-family: var(--font-heading);
		font-weight: 600;
		font-size: var(--text-title);
		color: var(--color-warning-text);
	}

	.impact-desc {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.85;
		color: var(--color-warning-text);
	}

	.confirm-button {
		height: var(--control-h-field);
		border: none;
		border-radius: var(--radius-pill);
		background: var(--color-warning-button);
		color: var(--color-warning-button-text);
		font-family: var(--font-sans);
		font-size: var(--text-body);
		font-weight: 700;
		cursor: pointer;
	}

	.confirm-button:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.section-label {
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.diff-list,
	.memo-list {
		list-style: none;
		margin: 0;
		padding: 0 16px;
		background: var(--color-surface-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}

	.diff-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 12px 0;
		border-bottom: 1px solid var(--color-border-subtle);
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.diff-row:last-child {
		border-bottom: none;
	}

	.diff-highlight {
		color: var(--color-accent-hover);
		font-weight: 500;
	}

	.diff-status {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.memo-list li {
		padding: 12px 0;
		border-bottom: 1px solid var(--color-border-subtle);
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.memo-list li:last-child {
		border-bottom: none;
	}

	.hint {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.delete-form {
		display: block;
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}
</style>
