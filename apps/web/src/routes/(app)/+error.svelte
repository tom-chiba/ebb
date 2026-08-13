<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	// #10/#13 由来の error(401/404/409/500, …) はこれまで /api/*（JSON API）と
	// /debug/*（開発者専用ページ）からしか投げられていなかった。#14 で初めて
	// ホーム/メモ/復習/設定など実際のユーザー向け HTML ページ（一覧・詳細・編集の load/action）
	// から到達可能になったため、SvelteKit 既定の英語・無装飾エラーページのままだと
	// 「ページ全体を日本語で統一する」という方針と矛盾する。別タブでの削除後に
	// 詳細/編集を開く（404）、編集中のセッション切れ（401）などで実際に踏める経路。
	let status = $derived(page.status);
</script>

{#if status === 401}
	<h1>ログインが必要です</h1>
	<p>セッションが切れた可能性があります。もう一度ログインしてください。</p>
	<a href={resolve('/login')}>ログインへ</a>
{:else if status === 404}
	<h1>見つかりません</h1>
	<p>このメモは存在しないか、既に削除されています。</p>
	<a href={resolve('/memos')}>メモ一覧へ</a>
{:else if status === 409}
	<h1>競合が発生しました</h1>
	<p>他の変更と競合しました。ページを再読み込みしてやり直してください。</p>
	<a href={resolve('/memos')}>メモ一覧へ</a>
{:else}
	<h1>エラーが発生しました</h1>
	<p>しばらくしてからもう一度お試しください。</p>
	<a href={resolve('/memos')}>メモ一覧へ</a>
{/if}
