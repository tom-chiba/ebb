<script lang="ts">
	import { formatIntervals, parseIntervals } from '@ebb/core';
	import { resolve } from '$app/paths';
	import IntervalStepEditor from '$lib/components/IntervalStepEditor.svelte';
	import { formatDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let name = $state(form?.name ?? '');
	let steps = $state(form?.intervals ? safeParseIntervals(form.intervals) : []);

	// 直前の送信が失敗した場合、hidden field 経由で受け取った生の intervals 文字列を
	// ステップ一覧へ復元する。ここに来る値は IntervalStepEditor が構築した
	// formatIntervals() の出力のはずだが、フォーム再送・改ざん等で不正な文字列が
	// 来る可能性もゼロではないため、失敗時は空のステップ一覧にフォールバックする
	// （エラーメッセージ自体はサーバー側の form.message でそのまま表示される）。
	function safeParseIntervals(raw: string): number[] {
		try {
			return parseIntervals(raw);
		} catch {
			return [];
		}
	}

	// このページを開いた時点を基準にした「実時刻プレビュー」。実際の保存時刻とは
	// ずれ得るが、あくまで目安表示のため、送信のたびに再計算する必要はない。
	const baseTime = new Date();
</script>

<form method="POST">
	<input type="hidden" name="intervals" value={formatIntervals(steps)} />

	<div class="header">
		<a href={resolve('/settings')}>キャンセル</a>
		<div class="header-label">プリセットを追加</div>
		<button type="submit" disabled={steps.length === 0}>保存</button>
	</div>

	<div class="fields">
		<label class="name-field">
			<span class="field-label">名前</span>
			<input
				type="text"
				name="name"
				bind:value={name}
				maxlength={data.presetNameMaxLength}
				required
			/>
			<span class="char-count">{name.length} / {data.presetNameMaxLength}</span>
		</label>

		<IntervalStepEditor bind:steps maxIntervalCount={data.maxIntervalCount} {baseTime} />

		<p class="hint">
			プレビューは、メモを {formatDateTime(baseTime)} に作成した場合の日時です。
		</p>

		{#if form?.message}
			<p class="error">{form.message}</p>
		{/if}
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.header a {
		font-size: 0.84rem;
		color: var(--color-text-muted);
	}

	.header-label {
		font-size: 0.78rem;
		color: var(--color-text-caption);
	}

	.header button {
		border: none;
		background: var(--color-accent);
		color: var(--color-surface-card);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 700;
		border-radius: var(--radius-button);
		padding: 0.5rem 1rem;
		cursor: pointer;
	}

	.header button:disabled {
		background: var(--color-border-strong);
		cursor: not-allowed;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1rem 0;
	}

	.name-field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.field-label {
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.name-field input {
		height: 2.875rem;
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-card);
		background: var(--color-surface-input);
		padding: 0 0.875rem;
		font-family: var(--font-sans);
		font-size: 0.9375rem;
		color: var(--color-text);
	}

	.char-count {
		align-self: flex-end;
		font-size: 0.69rem;
		color: var(--color-text-faint);
	}

	.hint {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.85;
		color: var(--color-text-caption);
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}
</style>
