<script lang="ts">
import favicon from '$lib/assets/favicon.svg';
import '../app.css';

const { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app-layout">
	<nav class="app-nav">
		<a href="/" class="nav-link">Monitor</a>
		<a href="/graph" class="nav-link">Graph</a>
	</nav>
	<div class="app-content">
		{@render children()}
	</div>
</div>

<style>
	.app-layout {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100vw;
		overflow: hidden;
	}

	.app-nav {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
		background: #1e293b;
		border-bottom: 1px solid #334155;
	}

	.nav-link {
		padding: 8px 16px;
		color: #cbd5e1;
		text-decoration: none;
		border-radius: 6px;
		font-size: 0.95rem;
		font-weight: 500;
		transition: all 0.2s;
	}

	.nav-link:hover {
		background: #334155;
		color: #f1f5f9;
	}

	.app-content {
		flex: 1;
		overflow: auto;
	}
</style>
