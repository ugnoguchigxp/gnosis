<script lang="ts">
import { page } from '$app/stores';
import favicon from '$lib/assets/favicon.svg';
import '../app.css';

const { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app-layout">
	<nav class="app-nav">
		<a href="/" class="nav-link" class:active={$page.url.pathname === '/'}>Monitor</a>

		<a href="/tasks" class="nav-link" class:active={$page.url.pathname === '/tasks'}>Queue</a>
		<a href="/graph" class="nav-link" class:active={$page.url.pathname === '/graph'}>Graph</a>
		<a href="/memories" class="nav-link" class:active={$page.url.pathname === '/memories'}>Memories</a>
		<a href="/sessions" class="nav-link" class:active={$page.url.pathname === '/sessions'}>Sessions</a>
		<a href="/failure-firewall" class="nav-link" class:active={$page.url.pathname === '/failure-firewall'}>Firewall</a>
		<a href="/reviews" class="nav-link" class:active={$page.url.pathname === '/reviews'}>Reviews</a>
		<a href="/knowflow-evals" class="nav-link" class:active={$page.url.pathname === '/knowflow-evals'}>Evals</a>
		<a href="/ops" class="nav-link" class:active={$page.url.pathname.startsWith('/ops')}>Ops</a>
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
		gap: 12px;
		padding: 0.75rem 1.5rem;
		background: rgba(15, 23, 42, 0.8);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--panel-border);
		z-index: 100;
	}

	.nav-link {
		padding: 0.5rem 1rem;
		color: var(--text-secondary);
		text-decoration: none;
		border-radius: 8px;
		font-size: 0.9rem;
		font-weight: 500;
		transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.nav-link:hover {
		background: rgba(255, 255, 255, 0.05);
		color: var(--text-primary);
	}

	.nav-link:active {
		background: rgba(59, 130, 246, 0.1);
		color: var(--accent-primary);
	}

	.nav-link.active {
		background: #e2e8f0;
		color: #0f172a;
	}

	.app-content {
		flex: 1;
		overflow: auto;
	}
</style>
