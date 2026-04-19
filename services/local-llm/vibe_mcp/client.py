import asyncio
import os
import subprocess
import json
import atexit
from typing import Any, Dict, List, Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class VibeMcpClient:
    def __init__(self, root_dir: str):
        self.root_dir = root_dir
        self.session: Optional[ClientSession] = None
        self._exit_stack = None
        self._client_context = None
        # atexit用に登録
        atexit.register(lambda: asyncio.run(self.stop()) if self.session else None)

    async def start(self):
        """Spawn the Gnosis TS process as an MCP server and connect to it."""
        # index.ts は stderr にログを出すため、それを抽出してファイルに永続化させる
        log_path = os.path.abspath(os.path.join(self.root_dir, "services/local-llm/mcp_server.log"))
        
        # StdioServerParameters が stderr のリダイレクトを直接サポートしていないため bash 経由で実行
        server_params = StdioServerParameters(
            command="bash",
            args=[
                "-c", 
                f"bun run {os.path.join(self.root_dir, 'src/index.ts')} 2>> {log_path}"
            ],
            env={
                **os.environ, 
                "NODE_ENV": "development",
                "GNOSIS_NO_WORKERS": "true"
            }
        )

        self._client_context = stdio_client(server_params)
        read, write = await self._client_context.__aenter__()
        self.session = ClientSession(read, write)
        await self.session.__aenter__()
        await self.session.initialize()

    async def list_tools(self) -> List[Dict[str, Any]]:
        if not self.session:
            return []
        result = await self.session.list_tools()
        return [{"name": t.name, "description": t.description, "inputSchema": t.inputSchema} for t in result.tools]

    async def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        if not self.session:
            raise RuntimeError("MCP Session not started")
        result = await self.session.call_tool(name, arguments)
        return result.content

    async def stop(self):
        try:
            if self.session:
                await self.session.__aexit__(None, None, None)
            if self._client_context:
                await self._client_context.__aexit__(None, None, None)
        except Exception as e:
            # Silence expected cancellation/asyncio issues during shutdown
            pass
        finally:
            self.session = None
            self._client_context = None

async def test_client():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
    client = VibeMcpClient(root)
    try:
        print("[MCP] Starting Gnosis TS server...")
        await client.start()
        print("[MCP] Fetching tools...")
        tools = await client.list_tools()
        for t in tools:
            print(f" - {t['name']}: {t['description']}")
        
        # Test call if needed
        # res = await client.call_tool("mcp_gnosis_query_graph", {"query": "TDD"})
        # print(res)
    finally:
        await client.stop()

if __name__ == "__main__":
    asyncio.run(test_client())
