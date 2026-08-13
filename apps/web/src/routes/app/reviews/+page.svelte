<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let hasPrev = $derived(data.offset > 0);
	let hasNext = $derived(data.offset + data.items.length < data.total);
	let prevOffset = $derived(Math.max(0, data.offset - data.limit));
	let nextOffset = $derived(data.offset + data.limit);

	function formatDateTime(date: Date) {
		return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(
			date
		);
	}
</script>

<h1>今日の復習</h1>

{#if data.completedTitle}
	{@const nextScheduledAt = data.nextScheduledAt}
	<p class="flash">
		「{data.completedTitle}」の復習を記録しました。
		{#if nextScheduledAt}
			次回は {formatDateTime(nextScheduledAt)} です。
		{:else}
			このメモの復習はすべて完了しました。
		{/if}
	</p>
{/if}

{#if data.items.length === 0}
	{#if data.total === 0}
		<p>今、期限が来ている復習はありません。</p>
	{:else}
		<p>このページに表示する復習はありません。</p>
	{/if}
{:else}
	<p>全 {data.total} 件溜まっています。</p>
	<ul>
		{#each data.items as review (review.id)}
			<li>
				<a href={resolve('/app/reviews/[id]', { id: review.id })}>{review.memoTitle}</a>
				<p>期限: {formatDateTime(review.scheduledAt)}</p>
			</li>
		{/each}
	</ul>
{/if}

<nav>
	{#if hasPrev}
		<a href="{resolve('/app/reviews')}?offset={prevOffset}">← 前へ</a>
	{/if}
	{#if hasNext}
		<a href="{resolve('/app/reviews')}?offset={nextOffset}">もっと見る →</a>
	{/if}
</nav>

<style>
	.flash {
		background: var(--color-accent-bg);
		border: 1px solid var(--color-accent-border);
		border-radius: var(--radius-md);
		padding: 0.75rem 1rem;
	}

	ul {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	li {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 0.75rem 1rem;
	}

	li p {
		margin: 0.4rem 0 0;
		color: var(--color-text-muted);
	}

	nav {
		display: flex;
		justify-content: space-between;
		margin-top: 1.5rem;
	}
</style>
