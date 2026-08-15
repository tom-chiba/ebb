<script lang="ts">
	import { resolve } from '$app/paths';
	import BottomBar from '$lib/components/BottomBar.svelte';
	import Button from '$lib/components/Button.svelte';
	import MarkdownBody from '$lib/components/MarkdownBody.svelte';
	import { formatDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="header">
	<a href={resolve('/reviews')}>‹ 復習</a>
	<span class="progress">{data.review.step + 1} 回目 / 全 {data.review.totalSteps} 回</span>
</div>

<article class="content">
	<h1>{data.review.memoTitle}</h1>
	<MarkdownBody content={data.renderedContent} />
</article>

<BottomBar>
	<form method="POST" action="?/complete">
		{#if data.from}
			<input type="hidden" name="from" value={data.from} />
		{/if}
		<Button variant="primary" type="submit">復習した</Button>
	</form>
	<p class="preview">
		{#if data.review.previewNextScheduledAt}
			記録すると次回は {formatDateTime(data.review.previewNextScheduledAt)} に届きます。
		{:else}
			記録するとこのメモの復習はすべて完了します。
		{/if}
	</p>
</BottomBar>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 20px;
		margin-bottom: 20px;
	}

	.header a {
		font-size: var(--text-small);
		color: var(--color-text-muted);
	}

	.progress {
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	.content {
		margin-bottom: calc(var(--bottom-bar-height, 128px) + 16px);
	}

	form {
		margin: 0;
	}

	.preview {
		margin: 0.6rem 0 0;
		text-align: center;
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}
</style>
