<script lang="ts">
	import { resolve } from '$app/paths';
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
	<div class="markdown-body">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown() は html:false のレンダラ設定により生 HTML を常にエスケープするため、ここで実行可能なマークアップが混入する余地はない -->
		{@html data.renderedContent}
	</div>
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

	.markdown-body {
		line-height: 1.8;
	}

	.markdown-body :global(h1),
	.markdown-body :global(h2),
	.markdown-body :global(h3) {
		margin: 1.4em 0 0.5em;
	}

	.markdown-body :global(ul),
	.markdown-body :global(ol) {
		padding-left: 1.4em;
	}

	.markdown-body :global(blockquote) {
		margin: 0 0 1em;
		padding-left: 0.9em;
		border-left: 3px solid var(--color-border);
		color: var(--color-text-muted);
	}

	.markdown-body :global(code) {
		font-family: var(--font-mono);
		background: var(--color-code-inline-bg);
		padding: 0.1em 0.3em;
		border-radius: var(--radius-sm);
	}

	.markdown-body :global(pre) {
		background: var(--color-code-bg);
		color: var(--color-code-text);
		padding: 0.9em 1em;
		border-radius: var(--radius-md);
		overflow-x: auto;
	}

	.markdown-body :global(pre code) {
		background: none;
		padding: 0;
	}
</style>
