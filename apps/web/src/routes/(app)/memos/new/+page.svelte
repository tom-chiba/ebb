<script lang="ts">
	import { resolve } from '$app/paths';
	import IntervalPresetChips from '$lib/components/IntervalPresetChips.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let title = $state(form?.title ?? '');
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
			bind:value={title}
			maxlength={data.titleMaxLength}
			placeholder="タイトル"
			required
		/>

		<MarkdownEditor bind:value={content} name="content" maxlength={data.contentMaxLength} />
	</div>

	<IntervalPresetChips
		presets={data.presets}
		selectedId={form?.intervalPresetId ?? data.defaultPresetId}
	/>

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

	.error {
		color: var(--color-error);
	}
</style>
