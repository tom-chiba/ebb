<script lang="ts">
	import { resolve } from '$app/paths';
	import MarkdownBody from '$lib/components/MarkdownBody.svelte';
	import { formatDateTime } from '$lib/format-date-time';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="page">
	<div class="header">
		<a href={resolve('/reviews')}>← 一覧</a>
		<span class="progress">{data.review.step + 1} 回目 / 全 {data.review.totalSteps} 回</span>
	</div>

	<article class="content">
		<h1>{data.review.memoTitle}</h1>
		<MarkdownBody content={data.renderedContent} />
	</article>

	<div class="complete-bar">
		<form method="POST" action="?/complete">
			{#if data.from}
				<input type="hidden" name="from" value={data.from} />
			{/if}
			<button type="submit">復習した</button>
		</form>
		<p class="preview">
			{#if data.review.previewNextScheduledAt}
				記録すると次回は {formatDateTime(data.review.previewNextScheduledAt)} に届きます。
			{:else}
				記録するとこのメモの復習はすべて完了します。
			{/if}
		</p>
	</div>
</div>

<style>
	.page {
		/* .complete-bar の構成要素（ボタン + 上下パディング + プレビュー文言との
		   margin-top + プレビュー文言1行）をここで一度だけ定義し、.content の余白と
		   .complete-bar 自身の min-height の両方から参照する。ボタンの高さやパディングを
		   変える場合はこの1箇所を更新すれば両者が追随する（設計レビューで指摘: 個別の値を
		   それぞれの selector に書くと、片方だけ変更されて本文がバーに隠れる不整合が
		   起きうる）。1行で収まる場合の実高さと一致するが、プレビュー文言が長い画面幅で
		   2行に折り返す場合はこの値を超える（正確性レビューで指摘）。.content の
		   margin-bottom には別途 1rem の余裕を足しており、+layout.svelte の main の
		   padding-bottom（タブバー高 + 4.5rem）とも重なるため、2行になっても本文が
		   隠れるほどの不足には至らない。 */
		--complete-bar-button-height: 54px;
		--complete-bar-padding-y: 1rem;
		--complete-bar-preview-margin-top: 0.6rem;
		--complete-bar-preview-height: 1.5rem;
		--complete-bar-height: calc(
			var(--complete-bar-button-height) + var(--complete-bar-padding-y) * 2 +
				var(--complete-bar-preview-margin-top) + var(--complete-bar-preview-height)
		);
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.progress {
		font-size: 0.8rem;
		color: var(--color-text-caption);
	}

	/* 固定表示の .complete-bar が本文の末尾を隠さないよう、その実高さ分（+ 余裕）の
	   余白を確保する。 */
	.content {
		margin-bottom: calc(var(--complete-bar-height) + 1rem);
	}

	/* bottom は下部タブバー（自身の高さに env(safe-area-inset-bottom) を
	   含んでいる、apps/web/src/routes/(app)/+layout.svelte 参照）の直上に来る位置。
	   このバー自体は端末の下端に接しないため、padding にセーフエリアを重ねて
	   加算しない（正確性レビューで指摘: 二重加算していた）。 */
	.complete-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom));
		min-height: var(--complete-bar-height);
		box-sizing: border-box;
		padding: var(--complete-bar-padding-y) 0;
		background: var(--color-bg);
		border-top: 1px solid var(--color-border);
	}

	.complete-bar form {
		margin: 0;
	}

	.complete-bar button {
		width: 100%;
		height: var(--complete-bar-button-height);
		border: none;
		border-radius: var(--radius-button);
		background: var(--color-accent);
		color: var(--color-surface-card);
		font-family: var(--font-sans);
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
	}

	.complete-bar button:hover {
		background: var(--color-accent-hover);
	}

	.preview {
		/* --complete-bar-preview-height を実際にこの要素の高さに適用する（設計レビューで
		   指摘: 変数が calc() 内だけの参照で終わっており、この要素自身の高さを制約して
		   いなかった）。min-height は下限を保証するだけで、文言が2行に折り返した場合の
		   上限は制御しない（正確性レビューで指摘。2行になった場合の余白不足は
		   --complete-bar-height 側のコメントを参照）。 */
		min-height: var(--complete-bar-preview-height);
		margin: var(--complete-bar-preview-margin-top) 0 0;
		text-align: center;
		font-size: 0.72rem;
		color: var(--color-text-caption);
	}
</style>
