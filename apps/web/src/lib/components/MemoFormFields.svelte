<script lang="ts">
	import IntervalPresetChips from './IntervalPresetChips.svelte';
	import MarkdownEditor from './MarkdownEditor.svelte';

	let {
		titleMaxLength,
		contentMaxLength,
		presets,
		initialTitle,
		initialContent,
		initialPresetId
	}: {
		titleMaxLength: number;
		contentMaxLength: number;
		presets: { id: string; name: string }[];
		initialTitle: string;
		initialContent: string;
		initialPresetId: string;
	} = $props();

	// 初期値を直接 $state(...) の初期化式へ渡すと svelte-check の
	// state_referenced_locally 警告が出るため、関数呼び出しに包んで参照する
	// （SSR 時点でも評価されるため、JS 無効でも入力値保持は成立する）。
	function computeInitialTitle(): string {
		return initialTitle;
	}
	function computeInitialContent(): string {
		return initialContent;
	}
	function computeInitialPresetId(): string {
		return initialPresetId;
	}

	let title = $state(computeInitialTitle());
	let content = $state(computeInitialContent());
	let selectedPresetId = $state(computeInitialPresetId());

	// 新規・編集どちらのフォームも、サーバーから受け取る初期値（新規: 常に固定、
	// 編集: form の失敗結果 or data.memo）が変わったときだけ再同期する。
	// 自分の入力による title 等の変更ではこれらの props 自体は変わらないため、
	// この effect は再実行されない（memos/[id]/edit の 409 再同期ロジックと同じ方針）。
	$effect(() => {
		title = initialTitle;
		content = initialContent;
		selectedPresetId = initialPresetId;
	});
</script>

<div class="fields">
	<input
		type="text"
		name="title"
		class="title"
		bind:value={title}
		maxlength={titleMaxLength}
		placeholder="タイトル"
		required
	/>

	<MarkdownEditor bind:value={content} name="content" maxlength={contentMaxLength} />
</div>

<IntervalPresetChips {presets} bind:selectedId={selectedPresetId} />

<style>
	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 0;
		flex: 1;
	}

	.title {
		border: none;
		outline: none;
		background: transparent;
		font-family: var(--font-heading);
		font-weight: 600;
		font-size: 22px;
		color: var(--color-text);
		padding: 0;
	}
</style>
