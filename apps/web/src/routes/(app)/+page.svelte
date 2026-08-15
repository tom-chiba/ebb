<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Fab from '$lib/components/Fab.svelte';
	import Card from '$lib/components/Card.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeading from '$lib/components/PageHeading.svelte';
	import { formatDateTime, formatTime } from '$lib/format-date-time';
	import { needsPushReminder } from '$lib/push-subscribe';
	import type { ResolvedPathname } from '$app/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// 表示のたびの基準時刻。Workers ランタイムの既定タイムゾーンは UTC のため、
	// 表示用の時刻・暦日判定はいずれもここ（ブラウザ）で行う。
	const baseTime = new Date();

	// 通知が無効なまま使っているユーザーへの控えめなリマインド（#24）。
	// 一度「あとで」を押したら、しつこくならないよう数日は再表示しない。
	const REMINDER_DISMISS_KEY = 'ebb:push-reminder-dismissed-at';
	const REMINDER_DISMISS_DAYS = 3;

	let showReminder = $state(false);

	function isReminderDismissed(): boolean {
		const dismissedAt = Number(localStorage.getItem(REMINDER_DISMISS_KEY));
		if (!dismissedAt) return false;
		return Date.now() - dismissedAt < REMINDER_DISMISS_DAYS * 24 * 60 * 60 * 1000;
	}

	function dismissReminder() {
		localStorage.setItem(REMINDER_DISMISS_KEY, String(Date.now()));
		showReminder = false;
	}

	onMount(async () => {
		if (!data.vapidPublicKey || isReminderDismissed()) return;
		showReminder = await needsPushReminder();
	});

	let hasMore = $derived(data.total > data.items.length);

	// resolve() が返す型付きパスにクエリを追加した結果は plain string になるが、
	// resolve() 自体を通しているため実体は内部リンクとして安全（Card の href 型
	// との整合のためのキャスト）。
	function reviewHref(id: string): ResolvedPathname {
		return `${resolve('/(app)/reviews/[id]', { id })}?from=home` as ResolvedPathname;
	}

	function isSameDay(a: Date, b: Date) {
		return (
			a.getFullYear() === b.getFullYear() &&
			a.getMonth() === b.getMonth() &&
			a.getDate() === b.getDate()
		);
	}
</script>

<PageHeading
	title="復習するメモ"
	caption="期限が来た順 ・ {formatTime(baseTime)} 時点"
	count={data.items.length > 0 ? `${data.total} 件` : undefined}
/>

{#if showReminder}
	<div class="push-reminder">
		<span>復習の通知がまだ有効になっていません。</span>
		<div class="push-reminder-actions">
			<a href={resolve('/settings')}>設定で有効にする</a>
			<button type="button" onclick={dismissReminder}>あとで</button>
		</div>
	</div>
{/if}

{#if data.completedTitle}
	{@const nextScheduledAt = data.nextScheduledAt}
	<Flash>
		「{data.completedTitle}」を記録しました。
		{#if nextScheduledAt}
			次回は {formatDateTime(nextScheduledAt)}。
		{:else}
			このメモの復習はすべて完了しました。
		{/if}
	</Flash>
{/if}

{#if data.items.length === 0}
	<p class="empty">期限が来た復習はありません。</p>
{:else}
	<ul>
		{#each data.items as review (review.id)}
			<li>
				<Card href={reviewHref(review.id)}>
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
	{#if hasMore}
		<p class="more"><a href={resolve('/reviews')}>もっと見る ›</a></p>
	{/if}
{/if}

<Fab href={resolve('/memos/new')} label="新規メモを作成" />

<style>
	.empty {
		color: var(--color-text-muted);
	}

	.push-reminder {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		background: var(--color-surface-raised);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		padding: 12px 16px;
		font-size: var(--text-small);
		color: var(--color-text-muted);
		margin-bottom: var(--space-stack);
	}

	.push-reminder-actions {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		flex: none;
	}

	.push-reminder-actions a {
		color: var(--color-accent);
		font-weight: 500;
	}

	.push-reminder-actions button {
		font-family: var(--font-sans);
		font-size: var(--text-small);
		color: var(--color-text-faint);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
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

	.more {
		text-align: center;
		margin-top: 0.5rem;
		font-size: var(--text-small);
	}

	.more a {
		color: var(--color-accent);
	}
</style>
