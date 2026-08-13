<script lang="ts">
	import { resolve } from '$app/paths';
	import Fab from '$lib/components/Fab.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>ようこそ、{data.user.name} さん</h1>
<p><a href={resolve('/app/memos')}>メモを見る</a></p>

<Fab href={resolve('/app/memos/new')} label="新規メモを作成" />
