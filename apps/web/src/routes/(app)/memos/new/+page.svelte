<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let content = $state(form?.content ?? '');
</script>

<form method="POST">
	<input type="hidden" name="id" value={data.draftId} />

	<div class="header">
		<a href={resolve('/memos')}>キャンセル</a>
		<div class="header-label">新規メモ</div>
		<button type="submit">保存</button>
	</div>

	<div class="fields">
		<input
			type="text"
			name="title"
			class="title"
			value={form?.title ?? ''}
			maxlength={data.titleMaxLength}
			placeholder="タイトル"
			required
		/>

		<MarkdownEditor bind:value={content} name="content" maxlength={data.contentMaxLength} />

		<div class="counter">{content.length} / {data.contentMaxLength}</div>
	</div>

	<div class="presets">
		<div class="presets-label">間隔</div>
		<div class="chips">
			{#each data.presets as preset (preset.id)}
				<input
					type="radio"
					name="intervalPresetId"
					value={preset.id}
					id={`preset-${preset.id}`}
					checked={(form?.intervalPresetId ?? data.defaultPresetId) === preset.id}
					class="chip-input"
				/>
				<label for={`preset-${preset.id}`} class="chip">{preset.name}</label>
			{/each}
		</div>
	</div>

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}
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

	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 0;
		flex: 1;
	}

	.title {
		border: none;
		outline: none;
		background: transparent;
		font-family: var(--font-heading);
		font-weight: 600;
		font-size: 1.375rem;
		color: var(--color-text);
		padding: 0;
	}

	.counter {
		font-size: 0.6875rem;
		color: var(--color-text-faint);
		text-align: right;
	}

	.presets {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.625rem 0;
		border-top: 1px solid var(--color-border-subtle);
	}

	.presets-label {
		font-size: 0.72rem;
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.chips {
		display: flex;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.chip-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
	}

	.chip {
		display: inline-block;
		font-size: 0.72rem;
		color: var(--color-text-secondary);
		background: var(--color-surface-input);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-chip);
		padding: 0.3125rem 0.6875rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.chip-input:checked + .chip {
		color: var(--color-surface-card);
		background: var(--color-accent);
		border-color: var(--color-accent);
		font-weight: 500;
	}

	.chip-input:focus-visible + .chip {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	.error {
		color: var(--color-error);
	}
</style>
