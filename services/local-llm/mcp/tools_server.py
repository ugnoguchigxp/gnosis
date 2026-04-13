#!/usr/bin/env python3
"""
Gemma 4 Tools MCP Server
Brave Search and content fetching tools.
"""
import asyncio
from typing import Any

from dotenv import load_dotenv
from mcp import stdio_server
from mcp.server import Server
from mcp.types import TextContent, Tool

from tools import fetch_content, search_web

load_dotenv()

app = Server("gemma4-tools")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="web_search",
            description="Brave Search API を使ってウェブ検索を実行します。",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "検索クエリ",
                    }
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="search_web",
            description="web_search の互換エイリアス。",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "検索クエリ",
                    }
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="fetch_content",
            description="指定URLから本文テキストを取得します。",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "取得対象のURL",
                    }
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="scrape_content",
            description="fetch_content の互換エイリアス。",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "取得対象のURL",
                    }
                },
                "required": ["url"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: Any) -> list[TextContent]:
    if name in {"web_search", "search_web"}:
        query = arguments.get("query", "")
        if not query:
            return [TextContent(type="text", text="Error: query parameter is required")]
        result = await asyncio.to_thread(search_web, query)
        return [TextContent(type="text", text=result)]

    if name in {"fetch_content", "scrape_content"}:
        url = arguments.get("url", "")
        if not url:
            return [TextContent(type="text", text="Error: url parameter is required")]
        result = await asyncio.to_thread(fetch_content, url)
        return [TextContent(type="text", text=result)]

    return [TextContent(type="text", text=f"Error: Unknown tool '{name}'")]


async def main() -> None:
    async with stdio_server() as streams:
        await app.run(streams[0], streams[1], app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
