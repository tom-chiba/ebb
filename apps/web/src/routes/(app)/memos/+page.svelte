<script lang="ts">
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import Card from '$lib/components/Card.svelte';
	import Fab from '$lib/components/Fab.svelte';
	import PageHeading from '$lib/components/PageHeading.svelte';
	import Button from '$lib/components/Button.svelte';
	import { formatShortDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let hasPrev = $derived(data.offset > 0);
	let hasNext = $derived(data.offset + data.items.length < data.total);
	let prevOffset = $derived(Math.max(0, data.offset - data.limit));
	let nextOffset = $derived(data.offset + data.limit);

	function paramsFor(offset: number): string {
		const params = new SvelteURLSearchParams({ offset: String(offset) });
		if (data.q) params.set('q', data.q);
		return params.toString();
	}
</script>

<PageHeading
	title="メモ"
	caption="更新が新しい順"
	count={data.total > 0 ? (data.q ? `${data.total} 件` : `全 ${data.total} 件`) : undefined}
/>

<form class="search" method="GET">
	<input type="search" name="q" value={data.q} placeholder="タイトル・本文で検索" />
</form>

{#if data.items.length === 0}
	{#if data.q && data.total === 0}
		<p class="empty">「{data.q}」に一致するメモはありません。</p>
	{:else if data.total === 0}
		<p class="empty">まだメモがありません。</p>
	{:else}
		<p class="empty">このページに表示するメモはありません。</p>
	{/if}
{:else}
	<ul>
		{#each data.items as memo (memo.id)}
			<li>
				<Card href={resolve('/(app)/memos/[id]', { id: memo.id })}>
					<div class="memo-title">{memo.title}</div>
					<p class="excerpt">{memo.excerpt}</p>
					<p class="meta">
						{#if memo.nextScheduledAt}
							次回 {formatShortDateTime(memo.nextScheduledAt)} ・ {memo.presetName}
						{:else}
							復習完了 ・ {memo.presetName}
						{/if}
					</p>
				</Card>
			</li>
		{/each}
	</ul>
{/if}

<nav>
	{#if hasPrev}
		<Button variant="compact" tone="neutral" href="{resolve('/memos')}?{paramsFor(prevOffset)}"
			>‹ 前へ</Button
		>
	{/if}
	{#if hasNext}
		<Button variant="compact" tone="neutral" href="{resolve('/memos')}?{paramsFor(nextOffset)}"
			>次へ ›</Button
		>
	{/if}
</nav>

<Fab href={resolve('/memos/new')} label="新規メモを作成" />

<style>
	.empty {
		color: var(--color-text-muted);
	}

	.search {
		margin-bottom: 1rem;
	}

	.search input {
		box-sizing: border-box;
		width: 100%;
		height: var(--control-h-field);
		border: 1px solid var(--color-border);
		background: var(--color-surface-input);
		border-radius: var(--radius-pill);
		padding: 0 var(--space-page);
		font-family: var(--font-sans);
		font-size: var(--text-body);
		color: var(--color-text);
	}

	.search input:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-stack);
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

	.meta {
		margin: 0.3rem 0 0;
		font-size: var(--text-caption);
		color: var(--color-text-caption);
	}

	nav {
		display: flex;
		justify-content: space-between;
		margin-top: 1.5rem;
	}
</style>
