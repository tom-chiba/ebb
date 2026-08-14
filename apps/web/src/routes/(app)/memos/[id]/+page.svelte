<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownBody from '$lib/components/MarkdownBody.svelte';
	import { formatShortDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function confirmDelete(event: SubmitEvent) {
		if (!confirm('このメモを削除しますか？元に戻せません。')) {
			event.preventDefault();
		}
	}
</script>

<div class="header">
	<a href={resolve('/memos')}>← メモ</a>
	<div class="links">
		<a href={resolve('/(app)/memos/[id]/edit', { id: data.memo.id })}>編集</a>
		<form method="POST" action="?/delete" onsubmit={confirmDelete}>
			<button type="submit" class="destructive">削除</button>
		</form>
	</div>
</div>

<article>
	<h1>{data.memo.title}</h1>

	<div class="chips">
		<span class="chip chip-accent">{data.presetName} {data.presetIntervalsText}</span>
		{#if data.nextScheduledAt}
			<span class="chip chip-muted">次回 {formatShortDateTime(data.nextScheduledAt)}</span>
		{:else}
			<span class="chip chip-muted">復習完了</span>
		{/if}
	</div>

	<MarkdownBody content={data.renderedContent} />

	<div class="schedule">
		<div class="schedule-label">復習スケジュール</div>
		{#each data.schedule as item (item.step)}
			<div class="schedule-row" class:next={item.isNext}>
				<span>{item.label}</span>
				{#if item.completedAt}
					<span class="schedule-status">完了 {formatShortDateTime(item.completedAt)}</span>
				{:else}
					<span class="schedule-status">{formatShortDateTime(item.scheduledAt)} 予定</span>
				{/if}
			</div>
		{/each}
	</div>
</article>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.links {
		display: flex;
		gap: 1.125rem;
		align-items: center;
	}

	.links form {
		margin: 0;
	}

	.links button {
		border: none;
		background: none;
		padding: 0;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		cursor: pointer;
		color: var(--color-accent);
	}

	.links button.destructive {
		color: var(--color-error);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.75rem 0 1rem;
	}

	.chip {
		font-size: 0.72rem;
		border-radius: var(--radius-chip);
		padding: 0.25rem 0.625rem;
	}

	.chip-accent {
		color: var(--color-accent-hover);
		background: var(--color-accent-bg);
		border: 1px solid var(--color-accent-border);
	}

	.chip-muted {
		color: var(--color-text-muted);
		background: var(--color-border-subtle);
		border: 1px solid var(--color-border);
	}

	.schedule {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border-subtle);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.schedule-label {
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.schedule-row {
		display: flex;
		justify-content: space-between;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
	}

	.schedule-row.next {
		color: var(--color-accent-hover);
		font-weight: 500;
	}

	.schedule-status {
		color: inherit;
	}
</style>
