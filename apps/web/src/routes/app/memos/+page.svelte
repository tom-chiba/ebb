<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let hasPrev = $derived(data.offset > 0);
	let hasNext = $derived(data.offset + data.items.length < data.total);
	let prevOffset = $derived(Math.max(0, data.offset - data.limit));
	let nextOffset = $derived(data.offset + data.limit);
</script>

<h1>メモ</h1>
<p><a href={resolve('/app/memos/new')}>＋ 新規作成</a></p>

{#if data.items.length === 0}
	{#if data.total === 0}
		<p>まだメモがありません。</p>
	{:else}
		<p>このページに表示するメモはありません。</p>
	{/if}
{:else}
	<ul>
		{#each data.items as memo (memo.id)}
			<li>
				<a href={resolve('/app/memos/[id]', { id: memo.id })}>{memo.title}</a>
				<p>{memo.excerpt}</p>
			</li>
		{/each}
	</ul>
{/if}

<nav>
	{#if hasPrev}
		<a href="{resolve('/app/memos')}?offset={prevOffset}">← 前へ</a>
	{/if}
	{#if hasNext}
		<a href="{resolve('/app/memos')}?offset={nextOffset}">次へ →</a>
	{/if}
</nav>

<style>
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
