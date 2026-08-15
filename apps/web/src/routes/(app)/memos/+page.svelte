<script lang="ts">
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import Fab from '$lib/components/Fab.svelte';
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

<div class="title-row">
	<h1>メモ</h1>
	{#if data.total > 0}
		<span class="count">{data.q ? `${data.total} 件` : `全 ${data.total} 件`}</span>
	{/if}
</div>

<form class="search" method="GET">
	<input type="search" name="q" value={data.q} placeholder="タイトル・本文で検索" />
</form>

{#if data.items.length === 0}
	{#if data.q && data.total === 0}
		<p>「{data.q}」に一致するメモはありません。</p>
	{:else if data.total === 0}
		<p>まだメモがありません。</p>
	{:else}
		<p>このページに表示するメモはありません。</p>
	{/if}
{:else}
	<ul>
		{#each data.items as memo (memo.id)}
			<li>
				<a href={resolve('/(app)/memos/[id]', { id: memo.id })}>
					<div class="memo-title">{memo.title}</div>
					<p class="excerpt">{memo.excerpt}</p>
					<p class="meta">
						{#if memo.nextScheduledAt}
							次回 {formatShortDateTime(memo.nextScheduledAt)} ・ {memo.presetName}
						{:else}
							復習完了 ・ {memo.presetName}
						{/if}
					</p>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<nav>
	{#if hasPrev}
		<a href="{resolve('/memos')}?{paramsFor(prevOffset)}">← 前へ</a>
	{/if}
	{#if hasNext}
		<a href="{resolve('/memos')}?{paramsFor(nextOffset)}">次へ →</a>
	{/if}
</nav>

<Fab href={resolve('/memos/new')} label="新規メモを作成" />

<style>
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	h1 {
		margin: 0;
	}

	.count {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.search {
		margin-bottom: 1rem;
	}

	.search input {
		box-sizing: border-box;
		width: 100%;
		height: 40px;
		border: 1px solid var(--color-border);
		background: var(--color-surface-input);
		border-radius: var(--radius-button);
		padding: 0 1rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-text);
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

	li a {
		display: block;
		color: inherit;
		text-decoration: none;
	}

	.memo-title {
		font-family: var(--font-heading);
		font-weight: 500;
	}

	.excerpt {
		margin: 0.4rem 0 0;
		color: var(--color-text-muted);
	}

	.meta {
		margin: 0.3rem 0 0;
		font-size: 0.72rem;
		color: var(--color-text-faint);
	}

	nav {
		display: flex;
		justify-content: space-between;
		margin-top: 1.5rem;
	}
</style>
