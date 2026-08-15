<script lang="ts">
	import { resolve } from '$app/paths';
	import Card from '$lib/components/Card.svelte';
	import Fab from '$lib/components/Fab.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeading from '$lib/components/PageHeading.svelte';
	import Button from '$lib/components/Button.svelte';
	import { formatDateTime, formatTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const baseTime = new Date();

	let hasPrev = $derived(data.offset > 0);
	let hasNext = $derived(data.offset + data.items.length < data.total);
	let prevOffset = $derived(Math.max(0, data.offset - data.limit));
	let nextOffset = $derived(data.offset + data.limit);

	function isSameDay(a: Date, b: Date) {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}
</script>

<PageHeading
	title="復習"
	caption="期限が来た順 ・ {formatTime(baseTime)} 時点"
	count={data.items.length > 0 ? `${data.total} 件` : undefined}
/>

{#if data.completedTitle}
	{@const nextScheduledAt = data.nextScheduledAt}
	<Flash>
		「{data.completedTitle}」の復習を記録しました。
		{#if nextScheduledAt}
			次回は {formatDateTime(nextScheduledAt)} です。
		{:else}
			このメモの復習はすべて完了しました。
		{/if}
	</Flash>
{/if}

{#if data.items.length === 0}
	{#if data.total === 0}
		<p class="empty">今、期限が来ている復習はありません。</p>
	{:else}
		<p class="empty">このページに表示する復習はありません。</p>
	{/if}
{:else}
	<ul>
		{#each data.items as review (review.id)}
			<li>
				<Card href={resolve('/(app)/reviews/[id]', { id: review.id })}>
					<div class="due">
						<span class="dot" class:overdue={!isSameDay(review.scheduledAt, baseTime)}></span>
						<span class="due-time">{formatTime(review.scheduledAt)} 期限</span>
					</div>
					<div class="memo-title">{review.memoTitle}</div>
					<p class="excerpt">{review.memoExcerpt}</p>
				</Card>
			</li>
		{/each}
	</ul>
{/if}

<nav>
	{#if hasPrev}
		<Button variant="compact" tone="neutral" href="{resolve('/reviews')}?offset={prevOffset}"
			>‹ 前へ</Button
		>
	{/if}
	{#if hasNext}
		<Button variant="compact" tone="neutral" href="{resolve('/reviews')}?offset={nextOffset}"
			>次へ ›</Button
		>
	{/if}
</nav>

<Fab href={resolve('/memos/new')} label="新規メモを作成" />

<style>
	.empty {
		color: var(--color-text-muted);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-stack);
	}

	.due {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent);
	}

	.dot.overdue {
		background: #b09b6a;
	}

	.due-time {
		font-size: var(--text-caption);
		font-weight: 500;
		color: var(--color-accent);
	}

	.dot.overdue + .due-time {
		color: #8a7c56;
	}

	.memo-title {
		font-family: var(--font-heading);
		font-weight: 500;
		font-size: var(--text-title);
		line-height: 1.5;
		color: var(--color-text);
	}

	.excerpt {
		margin: 0.4rem 0 0;
		font-size: var(--text-small);
		line-height: 1.75;
		color: var(--color-text-muted);
	}

	nav {
		display: flex;
		justify-content: space-between;
		margin-top: 1.5rem;
	}
</style>
