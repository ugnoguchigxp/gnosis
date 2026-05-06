# Single-Process MCP Runtime Plan

## Goal

Gnosis, Astmend, and diffGuard MCP runtimes should not leave one long-lived Bun
process per Codex reconnect. The target steady state is one long-lived host
process for all local MCP services, plus short-lived stdio adapter processes
that exit when the client connection closes.

The design is process-oriented, not tool-oriented:

- One host process owns service instances, lifecycle, registry, and cleanup.
- Each MCP server is mounted into that host as an in-process service module.
- Codex-facing stdio adapters are thin protocol bridges and must be disposable.
- Background workers and schedulers live only in the host for adapter-autostart
  mode, never in stdio adapters. In LaunchAgent mode, `com.gnosis.mcp-host`
  sets `GNOSIS_NO_WORKERS=true` so the existing `com.gnosis.worker` job remains
  the single background worker owner.

## Current Problem

The current Codex config starts three independent Bun MCP processes:

- `gnosis`: `bun run src/index.ts`
- `astmend`: `bun run src/mcp/server.ts`
- `diffguard`: `bun run src/mcp/server.ts`

When Codex reconnects or reloads, these stdio server processes can remain alive
under the Codex app-server parent. They are not necessarily Unix zombie
processes; they are live idle processes. That is still a runtime leak because
the intended ownership boundary is gone.

Gnosis also currently allows healthy duplicate `mcp-server` entries at startup
to avoid killing sibling MCP sessions. That fixed `Transport closed` risk, but
it means duplicate healthy processes are not reclaimed during normal startup.

## Target Architecture

```text
Codex MCP client
  -> short-lived stdio adapter process
      -> Unix domain socket or local pipe
          -> single local MCP host process
              -> gnosis service module
              -> astmend service module
              -> diffguard service module
              -> lifecycle registry
              -> optional background workers
```

The host is the only long-lived Bun process for the combined local MCP runtime.
The stdio adapter may be spawned by Codex many times, but it must not hold DB
pools, background intervals, schedulers, or service-level caches.

## Shared Contract

### Host Responsibilities

- Acquire a singleton host lock for the current user.
- Open and own the Unix socket.
- Load Gnosis, Astmend, and diffGuard tool definitions in-process.
- Route tool calls by namespace.
- Own DB pools, background workers, process registry, and runtime cleanup.
- Emit heartbeat and diagnostic state.
- Shut down gracefully on explicit stop or fatal startup error.

### Adapter Responsibilities

- Speak MCP stdio to Codex.
- Forward `tools/list` and `tools/call` to the host.
- Start the host only if it is not running and autostart is enabled.
- Exit when stdin closes, parent is lost, or an idle timeout elapses.
- Never start background workers.
- Never register as a long-lived runtime.

### Tool Namespace

Use stable names that match current exposed tools where possible.

- `gnosis.*` may keep existing public tool names for backward compatibility
  inside the Gnosis server.
- Astmend tools should be exposed under an `astmend` service namespace in the
  host router.
- diffGuard tools should be exposed under a `diffguard` service namespace in the
  host router.

The Codex-facing MCP server can still present the same tool names that the
current config exposes. Internally, routing must know the owning service.

## Gnosis Implementation Plan

### Phase 1: Extract Service Surface

Files:

- `src/mcp/server.ts`
- `src/mcp/tools/index.ts`
- `src/index.ts`
- `src/runtime/lifecycle.ts`

Tasks:

1. Extract a pure `createGnosisMcpService()` function that returns tool
   metadata and a `callTool(name, args)` handler.
2. Keep stdio-specific `StdioServerTransport` wiring out of service creation.
3. Ensure the current primary six tools (`initial_instructions`,
   `agentic_search`, `search_knowledge`, `record_task_note`, `review_task`,
   `doctor`) behave identically through the extracted service. Legacy
   lifecycle tools such as `activate_project`, `start_task`, and `finish_task`
   must not be reintroduced to the public surface.

Acceptance:

- Existing MCP tool snapshot tests still pass.
- Importing the service module does not change `process.title` or start IO.

### Phase 2: Build Host Runtime

Files:

- `src/mcp/host.ts`
- `src/mcp/hostProtocol.ts`
- `src/scripts/mcp-host.ts`
- `scripts/automation/com.gnosis.mcp-host.plist`
- `src/runtime/processRegistry.ts`
- `src/runtime/lifecycle.ts`

Tasks:

1. Add a singleton host process with a Unix socket under `.gnosis/mcp-host.sock`
   or the user temp directory.
2. Register the host with role `mcp-host`.
3. Move background worker startup from `src/index.ts` into the host only.
4. Add a macOS LaunchAgent with `RunAtLoad` / `KeepAlive` for login-time host
   startup. The LaunchAgent sets `GNOSIS_MCP_HOST_REPLACE_EXISTING=true` so it
   can take ownership from a manually started host without entering a restart
   loop.
5. Add a small request protocol:
   - `listTools`
   - `callTool`
   - `health`
   - `shutdown`
6. Add request IDs and structured errors so adapter failures are diagnosable.

Acceptance:

- Running the host twice results in one live host and one clean exit.
- `health` reports loaded services, pid, socket path, uptime, and worker state.
- Background workers start once, not once per MCP adapter.

### Phase 3: Replace Stdio Server With Adapter

Files:

- `src/index.ts`
- `src/mcp/stdioAdapter.ts`
- `package.json`
- `docs/startup.md`
- `docs/daemon.md`

Tasks:

1. Make `src/index.ts` a thin MCP stdio adapter.
2. Forward `tools/list` and `tools/call` to the host.
3. Autostart the host when the socket is missing.
4. Exit the adapter on stdin close, transport close, parent lost, or idle
   timeout.
5. Keep the old direct stdio server behind a temporary explicit command only if
   needed for testing.

Acceptance:

- Repeatedly starting and closing the adapter leaves no adapter processes.
- Only one host process remains after repeated Codex reconnects.
- `bun run process:diagnose` distinguishes host, adapter, and legacy processes.

### Phase 4: Integrate Astmend and diffGuard

Files:

- `src/mcp/host.ts`
- `src/mcp/services/astmend.ts`
- `src/mcp/services/diffguard.ts`
- `src/mcp/services/index.ts`
- Adjacent repo package exports as described in their plans.

Tasks:

1. Load Astmend and diffGuard service factories from their repos or installed
   package entrypoints.
2. Normalize their tool result shapes to MCP responses.
3. Keep service-specific dependencies isolated so one service failure does not
   crash the host.

Acceptance:

- Host `listTools` includes Gnosis, Astmend, and diffGuard tools.
- Astmend and diffGuard tool calls work through the single host process.
- Failing one service call returns a tool error without killing the host.

Status:

- Done in Gnosis host. Astmend and diffGuard are loaded from local service
  factories, with `ASTMEND_REPO_PATH` and `DIFFGUARD_REPO_PATH` as overrides.
  Codex should remove direct Astmend/diffGuard MCP server entries after this
  phase so no long-lived per-repo Bun stdio processes are spawned.

## Watchdog Position

The ideal steady state does not require a watchdog for normal operation.
However, the watchdog should remain during and after the migration as a
diagnostic and recovery tool.

Keep watchdog for:

- Detecting legacy direct stdio servers that should no longer be long-lived.
- Cleaning stale registry files after crashes.
- Reporting contract violations, such as multiple hosts or long-lived adapters.
- Emergency cleanup through an explicit `--apply` path.

Do not rely on watchdog for:

- Normal duplicate suppression at host startup.
- Routine lifecycle correctness.
- Killing healthy service processes just because another session exists.

Once the host/adapter contract is stable, watchdog should mostly report
`healthy host` and `no stale adapters`. If it has to clean processes every day,
the lifecycle contract is still broken.

## Validation Commands

Run from `/Users/y.noguchi/Code/gnosis`:

```bash
bun run lint
bun run typecheck
bun test test/mcpStdioIntegration.test.ts test/runtimeLifecycle.test.ts test/processDedupe.test.ts
bun run process:diagnose
```

Manual runtime validation:

```bash
for i in 1 2 3 4 5; do
  timeout 5 bun run src/index.ts </dev/null >/tmp/gnosis-mcp-$i.out 2>/tmp/gnosis-mcp-$i.err || true
done
ps -axo pid,ppid,stat,lstart,command | rg 'bun .*gnosis|gnosis-mcp'
```

Expected result:

- One host process at most.
- Zero long-lived stdio adapter processes.
- No repeated background worker startup per adapter.

## Rollout Order

1. Land Gnosis service extraction and host/adapter runtime.
2. Land Astmend service factory export.
3. Land diffGuard service factory export.
4. Wire both service factories into the Gnosis host.
5. Update `~/.codex/config.toml` so Codex starts only the unified adapter.
6. Leave the old per-repo MCP commands documented as development-only fallback.
