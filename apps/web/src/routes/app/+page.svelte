<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>ようこそ、{data.user.name} さん</h1>
<p><a href={resolve('/app/memos')}>メモを見る</a></p>
