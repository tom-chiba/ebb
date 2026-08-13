<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>新規メモ</h1>

<form method="POST">
	<input type="hidden" name="id" value={data.draftId} />

	<label>
		タイトル
		<input
			type="text"
			name="title"
			value={form?.title ?? ''}
			maxlength={data.titleMaxLength}
			required
		/>
	</label>

	<label>
		本文（Markdown）
		<textarea name="content" rows="16" maxlength={data.contentMaxLength}
			>{form?.content ?? ''}</textarea
		>
	</label>

	{#if form?.message}
		<p class="error">{form.message}</p>
	{/if}

	<div class="actions">
		<a href={resolve('/app/memos')}>キャンセル</a>
		<button type="submit">保存</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 640px;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	textarea {
		font-family: inherit;
		resize: vertical;
	}

	.error {
		color: var(--color-error);
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
</style>
