<script lang="ts">
	import { resolve } from '$app/paths';
	import Fab from '$lib/components/Fab.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// 表示のたびの基準時刻。Workers ランタイムの既定タイムゾーンは UTC のため、
	// 表示用の時刻・暦日判定はいずれもここ（ブラウザ）で行う。
	const baseTime = new Date();

	let hasMore = $derived(data.total > data.items.length);

	function formatTime(date: Date) {
		return new Intl.DateTimeFormat('ja-JP', { timeStyle: 'short' }).format(date);
	}

	function formatDateTime(date: Date) {
		return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(
			date
		);
	}

	function isSameDay(a: Date, b: Date) {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}
</script>

<div class="header">
	<p class="caption">期限が来た順 ・ {formatTime(baseTime)} 時点</p>
	<div class="title-row">
		<h1>復習するメモ</h1>
		{#if data.items.length > 0}
			<span class="count">{data.total} 件</span>
		{/if}
	</div>
</div>

{#if data.completedTitle}
	{@const nextScheduledAt = data.nextScheduledAt}
	<p class="banner">
		「{data.completedTitle}」を記録しました。
		{#if nextScheduledAt}
			次回は {formatDateTime(nextScheduledAt)}。
		{:else}
			このメモの復習はすべて完了しました。
		{/if}
	</p>
{/if}

{#if data.items.length === 0}
	<p class="empty">期限が来た復習はありません。</p>
{:else}
	<ul>
		{#each data.items as review (review.id)}
			<li>
				<a href="{resolve('/(app)/reviews/[id]', { id: review.id })}?from=home">
					<div class="due">
						<span class="dot" class:overdue={!isSameDay(review.scheduledAt, baseTime)}></span>
						<span class="due-time">{formatTime(review.scheduledAt)} 期限</span>
					</div>
					<div class="memo-title">{review.memoTitle}</div>
					<p class="excerpt">{review.memoExcerpt}</p>
				</a>
			</li>
		{/each}
	</ul>
	{#if hasMore}
		<p class="more"><a href={resolve('/reviews')}>もっと見る</a></p>
	{/if}
{/if}

<Fab href={resolve('/memos/new')} label="新規メモを作成" />

<style>
	.header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 1rem;
	}

	.caption {
		margin: 0;
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	h1 {
		margin: 0;
	}

	.count {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.banner {
		background: var(--color-accent-bg);
		border: 1px solid var(--color-accent-border);
		border-radius: var(--radius-md);
		padding: 0.75rem 1rem;
		color: var(--color-accent-hover);
	}

	.empty {
		color: var(--color-text-muted);
	}

	ul {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	li a {
		display: block;
		background: var(--color-surface-card);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: 1rem 1rem 0.875rem;
		color: inherit;
		text-decoration: none;
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
		font-size: 0.72rem;
		font-weight: 500;
		color: var(--color-accent);
	}

	.dot.overdue + .due-time {
		color: #8a7c56;
	}

	.memo-title {
		font-family: var(--font-heading);
		font-weight: 500;
		font-size: 1.0625rem;
		line-height: 1.5;
		color: var(--color-text);
	}

	.excerpt {
		margin: 0.4rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.75;
		color: var(--color-text-muted);
	}

	.more {
		text-align: center;
		margin-top: 0.5rem;
	}
</style>
