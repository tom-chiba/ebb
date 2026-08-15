<script lang="ts">
	import { resolve } from '$app/paths';
	import BottomBar from '$lib/components/BottomBar.svelte';
	import Button from '$lib/components/Button.svelte';
	import Card from '$lib/components/Card.svelte';
	import DangerZone from '$lib/components/DangerZone.svelte';
	import MarkdownBody from '$lib/components/MarkdownBody.svelte';
	import { formatShortDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let completedCount = $derived(data.schedule.filter((item) => item.completedAt).length);

	function confirmDelete(event: SubmitEvent) {
		if (!confirm('このメモを削除しますか？元に戻せません。')) {
			event.preventDefault();
		}
	}
</script>

<div class="header">
	<a href={resolve('/memos')}>‹ メモ</a>
	<span class="progress">{completedCount} / {data.schedule.length} 回 完了</span>
</div>

<article class="content">
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

	<Card>
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
	</Card>

	<DangerZone>
		<form method="POST" action="?/delete" onsubmit={confirmDelete}>
			<Button variant="quiet" type="submit">このメモを削除</Button>
		</form>
	</DangerZone>
</article>

<BottomBar>
	<Button variant="primary" href={resolve('/(app)/memos/[id]/edit', { id: data.memo.id })}
		>編集する</Button
	>
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
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: calc(var(--bottom-bar-height, 96px) + 16px);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0;
	}

	.chip {
		font-size: var(--text-caption);
		border-radius: var(--radius-card);
		padding: 4px 10px;
	}

	.chip-accent {
		color: var(--color-accent-hover);
		background: var(--color-accent-bg);
		border: 1px solid var(--color-accent-border);
	}

	.chip-muted {
		color: var(--color-text-muted);
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
	}

	.schedule {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.schedule-label {
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.schedule-row {
		display: flex;
		justify-content: space-between;
		font-size: var(--text-small);
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
