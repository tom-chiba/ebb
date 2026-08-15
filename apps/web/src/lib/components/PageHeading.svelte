<script lang="ts">
	let {
		title,
		caption,
		count
	}: {
		title: string;
		caption?: string;
		count?: string;
	} = $props();
</script>

<div class="heading">
	{#if caption}
		<p class="caption">{caption}</p>
	{/if}
	<div class="title-row">
		<h1>{title}</h1>
		{#if count}
			<span class="count">{count}</span>
		{/if}
	</div>
</div>

<style>
	.heading {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 20px;
		margin-bottom: 14px;
	}

	.caption {
		margin: 0;
		font-size: var(--text-caption);
		letter-spacing: 0.06em;
		color: var(--color-text-caption);
	}

	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.count {
		font-size: var(--text-small);
		color: var(--color-text-muted);
	}
</style>
