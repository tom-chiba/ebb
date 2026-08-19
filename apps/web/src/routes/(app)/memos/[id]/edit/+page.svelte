<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import FormHeader from '$lib/components/FormHeader.svelte';
	import MemoFormFields from '$lib/components/MemoFormFields.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<form method="POST">
	<input
		type="hidden"
		name="expectedUpdatedAt"
		value={form?.expectedUpdatedAt ?? data.memo.updatedAt.toISOString()}
	/>

	<FormHeader cancelHref={resolve('/(app)/memos/[id]', { id: data.memo.id })} label="メモを編集">
		<Button variant="compact" type="submit">保存</Button>
	</FormHeader>

	<!-- 409(競合)後の「最新の内容を確認する」リンクは同一ルートへのクライアントサイド
	     ナビゲーションであり、このページ自体は再マウントされない。MemoFormFields は
	     initialTitle/initialContent/initialPresetId の変化を $effect で追跡して
	     再同期するため、ここで渡す値が変わりさえすれば再表示される。これが無いと、
	     古い入力のまま hidden の expectedUpdatedAt だけが最新値に更新され、
	     他の変更を無警告で上書きしてしまう（+page.server.ts の ConflictError コメント参照）。 -->
	<MemoFormFields
		titleMaxLength={data.titleMaxLength}
		contentMaxLength={data.contentMaxLength}
		presets={data.presets}
		initialTitle={form?.title ?? data.memo.title}
		initialContent={form?.content ?? data.memo.content}
		initialPresetId={form?.intervalPresetId ?? data.memo.intervalPresetId}
	/>

	{#if form?.message}
		<p class="error">{form.message}</p>
		{#if form.conflict}
			<a href={resolve('/(app)/memos/[id]/edit', { id: data.memo.id })}>最新の内容を確認する</a>
		{/if}
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
