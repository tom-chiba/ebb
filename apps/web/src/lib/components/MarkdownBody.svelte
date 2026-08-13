<script lang="ts">
	interface Props {
		content: string;
	}

	let { content }: Props = $props();
</script>

<div class="markdown-body">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown() は html:false のレンダラ設定により生 HTML を常にエスケープするため、ここで実行可能なマークアップが混入する余地はない -->
	{@html content}
</div>

<style>
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
