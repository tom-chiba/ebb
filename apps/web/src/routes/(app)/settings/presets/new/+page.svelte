<script lang="ts">
	import { formatIntervals, parseIntervals } from '@ebb/core';
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import FormHeader from '$lib/components/FormHeader.svelte';
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

	<FormHeader cancelHref={resolve('/settings')} label="プリセットを追加">
		<Button variant="compact" type="submit" disabled={steps.length === 0}>保存</Button>
	</FormHeader>

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
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.name-field input {
		height: var(--control-h-field);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-card);
		background: var(--color-surface-input);
		padding: 0 0.875rem;
		font-family: var(--font-sans);
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.name-field input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.char-count {
		align-self: flex-end;
		font-size: var(--text-caption);
		color: var(--color-text-faint);
	}

	.hint {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.85;
		color: var(--color-text-caption);
	}

	.error {
		color: var(--color-error);
		margin: 0;
	}
</style>
