<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import FormHeader from '$lib/components/FormHeader.svelte';
	import MemoFormFields from '$lib/components/MemoFormFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<form method="POST">
	<input type="hidden" name="id" value={data.draftId} />

	<FormHeader cancelHref={resolve('/memos')} label="新規メモ">
		<Button variant="compact" type="submit">保存</Button>
	</FormHeader>

	<MemoFormFields
		titleMaxLength={data.titleMaxLength}
		contentMaxLength={data.contentMaxLength}
		presets={data.presets}
		initialTitle={form?.title ?? ''}
		initialContent={form?.content ?? ''}
		initialPresetId={form?.intervalPresetId ?? data.defaultPresetId}
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

	.error {
		color: var(--color-error);
	}
</style>
