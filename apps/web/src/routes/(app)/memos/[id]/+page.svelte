<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownBody from '$lib/components/MarkdownBody.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function confirmDelete(event: SubmitEvent) {
		if (!confirm('このメモを削除しますか？元に戻せません。')) {
			event.preventDefault();
		}
	}
</script>

<article>
	<h1>{data.memo.title}</h1>
	<MarkdownBody content={data.renderedContent} />
</article>

<div class="actions">
	<a href={resolve('/app/memos')}>一覧へ戻る</a>
	<a href={resolve('/app/memos/[id]/edit', { id: data.memo.id })}>編集</a>
	<form method="POST" action="?/delete" onsubmit={confirmDelete}>
		<button type="submit">削除</button>
	</form>
</div>

<style>
	.actions {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.actions form {
		margin: 0;
	}
</style>
