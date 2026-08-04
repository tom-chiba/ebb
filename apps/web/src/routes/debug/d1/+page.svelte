<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h2>D1 疎通確認</h2>
<ul>
	{#each data.rows as row (row.id)}
		<li>{row.id}: {row.message}</li>
	{/each}
</ul>
