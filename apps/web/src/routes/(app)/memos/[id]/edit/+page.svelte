<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownEditor from '$lib/components/MarkdownEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let title = $state(form?.title ?? data.memo.title);
	let content = $state(form?.content ?? data.memo.content);

	// 409(競合)後の「最新の内容を確認する」リンクは同一ルートへのクライアントサイド
	// ナビゲーションであり、コンポーネントは再マウントされず $state の初期化式も
	// 再評価されない。$effect で form/data.memo の変化そのものを追跡し、そのときだけ
	// title/content を再同期する（自分の入力による title/content 自体の変更では
	// form/data が変わらないため、この effect は再実行されない）。これが無いと、
	// 本文だけ古いまま hidden の expectedUpdatedAt だけが最新値に更新され、
	// 他の変更を無警告で上書きしてしまう（+page.server.ts の ConflictError コメント参照）。
	$effect(() => {
		title = form?.title ?? data.memo.title;
		content = form?.content ?? data.memo.content;
	});
</script>

<form method="POST">
	<input
		type="hidden"
		name="expectedUpdatedAt"
		value={form?.expectedUpdatedAt ?? data.memo.updatedAt.toISOString()}
	/>

	<div class="header">
		<a href={resolve('/(app)/memos/[id]', { id: data.memo.id })}>キャンセル</a>
		<div class="header-label">メモを編集</div>
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

	<div class="presets">
		<div class="presets-label">間隔</div>
		<div class="chips">
			{#each data.presets as preset (preset.id)}
				<input
					type="radio"
					name="intervalPresetId"
					value={preset.id}
					id={`preset-${preset.id}`}
					checked={(form?.intervalPresetId ?? data.memo.intervalPresetId) === preset.id}
					class="chip-input"
				/>
				<label for={`preset-${preset.id}`} class="chip">{preset.name}</label>
			{/each}
		</div>
	</div>

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
