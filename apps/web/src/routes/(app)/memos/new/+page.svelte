<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import IntervalPresetChips from '$lib/components/IntervalPresetChips.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let title = $state(form?.title ?? '');
	let content = $state(form?.content ?? '');
	let selectedPresetId = $state(form?.intervalPresetId ?? data.defaultPresetId);
</script>

<form method="POST">
	<input type="hidden" name="id" value={data.draftId} />

	<div class="header">
		<a href={resolve('/memos')}>キャンセル</a>
		<div class="header-label">新規メモ</div>
		<Button variant="compact" type="submit">保存</Button>
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

	<IntervalPresetChips presets={data.presets} bind:selectedId={selectedPresetId} />

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
		font-size: 22px;
		color: var(--color-text);
		padding: 0;
	}

	.error {
		color: var(--color-error);
	}
</style>
