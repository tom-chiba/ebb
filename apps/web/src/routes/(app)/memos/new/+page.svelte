<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import FormHeader from '$lib/components/FormHeader.svelte';
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

	<FormHeader cancelHref={resolve('/memos')} label="新規メモ">
		<Button variant="compact" type="submit">保存</Button>
	</FormHeader>

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
