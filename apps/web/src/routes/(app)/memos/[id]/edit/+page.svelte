<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/components/Button.svelte';
	import FormHeader from '$lib/components/FormHeader.svelte';
	import IntervalPresetChips from '$lib/components/IntervalPresetChips.svelte';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let title = $state(form?.title ?? data.memo.title);
	let content = $state(form?.content ?? data.memo.content);
	let selectedPresetId = $state(form?.intervalPresetId ?? data.memo.intervalPresetId);

	// 409(競合)後の「最新の内容を確認する」リンクは同一ルートへのクライアントサイド
	// ナビゲーションであり、コンポーネントは再マウントされず $state の初期化式も
	// 再評価されない。$effect で form/data.memo の変化そのものを追跡し、そのときだけ
	// title/content/selectedPresetId を再同期する（自分の入力によるこれらの変更では
	// form/data が変わらないため、この effect は再実行されない）。これが無いと、
	// 古い入力のまま hidden の expectedUpdatedAt だけが最新値に更新され、
	// 他の変更を無警告で上書きしてしまう（+page.server.ts の ConflictError コメント参照）。
	$effect(() => {
		title = form?.title ?? data.memo.title;
		content = form?.content ?? data.memo.content;
		selectedPresetId = form?.intervalPresetId ?? data.memo.intervalPresetId;
	});
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
