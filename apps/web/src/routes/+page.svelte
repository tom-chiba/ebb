<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Welcome to SvelteKit</h1>
<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>

<h2>D1 疎通確認</h2>
<ul>
	{#each data.rows as row (row.id)}
		<li>{row.id}: {row.message}</li>
	{/each}
</ul>
