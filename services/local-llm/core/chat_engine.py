from __future__ import annotations

import json
import re
import asyncio
from typing import Any, Iterable, Generator, List, Dict

from core.model import MLXModelManager, get_model_manager
from tools import fetch_content, search_web
from core.repair_util import detect_repair_json, format_repair_prompt

TOOL_CALL_RE = re.compile(
    r"(?:<\|tool_call\|>|<tool_call>)\s*call:(\w+)\s*\{(.*?)\}\s*(?:<tool_call\|>|<\|tool_call\|>|</tool_call>)",
    re.DOTALL,
)
JSON_TOOL_CALL_RE = re.compile(
    r"(?:<\|tool_call\|>|<tool_call>)\s*(\{.*?\})\s*(?:<tool_call\|>|<\|tool_call\|>|</tool_call>)",
    re.DOTALL,
)
TOOL_ARGS_RE = re.compile(r"(\w+)\s*:\s*<\|\"\|>(.*?)<\|\"\|>", re.DOTALL)
TOOL_ARGS_QUOTED_RE = re.compile(r"(\w+)\s*:\s*\"(.*?)\"", re.DOTALL)
TOOL_ARGS_SINGLE_QUOTED_RE = re.compile(r"(\w+)\s*:\s*'(.*?)'", re.DOTALL)
TOOL_ARGS_BARE_RE = re.compile(r"(\w+)\s*:\s*([^,\n}]+)")
THINK_BLOCK_RE = re.compile(r"<\|channel>thought.*?(?:<channel\|>|$)", re.DOTALL)
LEGACY_THINK_BLOCK_RE = re.compile(r"<think>.*?(?:</think>|$)", re.DOTALL)
INCOMPLETE_TOOL_CALL_RE = re.compile(r"(?:<\|tool_call\|>|<tool_call>).*$", re.DOTALL)
JSON_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)


def _extract_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                chunks.append(str(item.get("text", "")))
        return "\n".join(c for c in chunks if c)
    return str(content)


def _normalize_tool_name(name: str) -> str:
    aliases = {
        "web_search": "search_web",
        "search_web": "search_web",
        "scrape_content": "fetch_content",
        "fetch_url": "fetch_content",
        "fetch_content": "fetch_content",
    }
    return aliases.get(name, name)


class ChatEngine:
    """Gemma chat engine with optional tool execution and streaming support."""

    def __init__(self, model_manager: Any | None = None, verbose: bool = False, max_tool_rounds: int = 3) -> None:
        # model_manager can be MLXModelManager or a backend object from backends/*.py
        self.model_manager = model_manager
        self.verbose = verbose
        self.max_tool_rounds = max_tool_rounds
        self.messages = []

    def reset(self, sys_instr: str):
        self.messages = [{"role": "system", "content": sys_instr}]

    def add_message(self, role: str, content: str):
        self.messages.append({"role": role, "content": content})

    @staticmethod
    def _parse_tool_payload(payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None

        func_name = payload.get("name")
        arguments: Any = payload.get("arguments", {})

        if not isinstance(func_name, str) and isinstance(payload.get("function"), dict):
            function = payload["function"]
            func_name = function.get("name")
            arguments = function.get("arguments", arguments)

        if not isinstance(func_name, str) and isinstance(payload.get("tool"), dict):
            tool = payload["tool"]
            func_name = tool.get("name")
            arguments = tool.get("arguments", arguments)

        if not isinstance(func_name, str) or not func_name:
            return None

        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                arguments = {}
        if not isinstance(arguments, dict):
            arguments = {}

        normalized_args = {str(k): str(v) for k, v in arguments.items()}
        return {"name": func_name, "arguments": normalized_args}

    @staticmethod
    def parse_tool_call(text: str) -> dict[str, Any] | None:
        # call:name{...} の形式を探す。周囲にノイズがあっても拾えるようにする
        match = re.search(r"call:(\w+)\s*\{(.*?)\}", text, re.DOTALL)
        if match:
            func_name, args_str = match.group(1), match.group(2)
            args: dict[str, str] = {}

            for arg_match in TOOL_ARGS_RE.finditer(args_str):
                args[arg_match.group(1)] = arg_match.group(2)
            if not args:
                for arg_match in TOOL_ARGS_QUOTED_RE.finditer(args_str):
                    args[arg_match.group(1)] = arg_match.group(2)
            if not args:
                for arg_match in TOOL_ARGS_SINGLE_QUOTED_RE.finditer(args_str):
                    args[arg_match.group(1)] = arg_match.group(2)
            if not args:
                for arg_match in TOOL_ARGS_BARE_RE.finditer(args_str):
                    args[arg_match.group(1)] = arg_match.group(2).strip()
            if not args and args_str.strip():
                try:
                    candidate = "{" + args_str + "}"
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict):
                        args = {str(k): str(v) for k, v in parsed.items()}
                except json.JSONDecodeError:
                    pass

            return {"name": func_name, "arguments": args}

        json_tag_match = JSON_TOOL_CALL_RE.search(text)
        if json_tag_match:
            try:
                payload = json.loads(json_tag_match.group(1))
                parsed = ChatEngine._parse_tool_payload(payload)
                if parsed:
                    return parsed
            except json.JSONDecodeError:
                pass

        payload = ChatEngine._extract_json_payload(text)
        if payload:
            try:
                parsed = ChatEngine._parse_tool_payload(json.loads(payload))
                if parsed:
                    return parsed
            except json.JSONDecodeError:
                pass

        return None

    @staticmethod
    def _extract_json_payload(text: str) -> str | None:
        code_block_match = JSON_CODE_BLOCK_RE.search(text)
        if code_block_match:
            candidate = code_block_match.group(1).strip()
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                pass

        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidate = text[start : end + 1].strip()
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                pass

        return None

    @staticmethod
    def sanitize_response(text: str, force_json: bool = False) -> str:
        # Remove thinking/tool tags
        sanitized = THINK_BLOCK_RE.sub("", text)
        sanitized = LEGACY_THINK_BLOCK_RE.sub("", sanitized)
        sanitized = TOOL_CALL_RE.sub("", sanitized)
        sanitized = JSON_TOOL_CALL_RE.sub("", sanitized)
        sanitized = INCOMPLETE_TOOL_CALL_RE.sub("", sanitized)
        sanitized = sanitized.replace("<channel|>", "").replace("<|channel>thought", "")
        sanitized = sanitized.replace("<|tool_call|>", "").replace("<tool_call|>", "")
        sanitized = sanitized.replace("<tool_call>", "").replace("</tool_call>", "")
        
        if force_json:
            payload = ChatEngine._extract_json_payload(sanitized)
            if payload is not None:
                return payload
        else:
            code_block_match = JSON_CODE_BLOCK_RE.fullmatch(sanitized.strip())
            if code_block_match:
                sanitized = code_block_match.group(1)
            
        return sanitized.strip()

    def _prepare_messages(self, messages: Iterable[dict[str, Any]], allow_tools: bool) -> list[dict[str, str]]:
        prepared: list[dict[str, str]] = []
        has_system = False

        for message in messages:
            role = str(message.get("role", "user"))
            content = _extract_text_content(message.get("content", ""))

            if role == "tool":
                role = "user"
                content = f"ツール結果:\n{content}"
            elif role not in {"system", "user", "assistant"}:
                role = "user"

            prepared.append({"role": role, "content": content})
            if role == "system":
                has_system = True

        if allow_tools:
            tool_instruction = (
                "必要な場合のみツールを呼び出してください。\n"
                "形式: <|tool_call|>call:関数名{引数名:<|\"|>値<|\"|>}<tool_call|>\n"
                "利用可能ツール: search_web(query) / web_search(query), fetch_content(url)"
            )
            if has_system and prepared:
                prepared[0]["content"] = f"{prepared[0]['content']}\n\n{tool_instruction}".strip()
            else:
                prepared.insert(0, {"role": "system", "content": tool_instruction})

        return prepared

    def _run_tool_sync(self, tool_call: dict[str, Any]) -> str:
        name = _normalize_tool_name(tool_call["name"])
        arguments = tool_call.get("arguments", {})

        try:
            if name == "search_web":
                query = arguments.get("query") or arguments.get("q")
                if not query:
                    return "Error: query parameter is required"
                return search_web(query)
            if name == "fetch_content":
                url = arguments.get("url")
                if not url:
                    return "Error: url parameter is required"
                return fetch_content(url)
            return f"Error: Unknown tool '{name}'"
        except Exception as e:
            return f"Error: Local tool execution failed ({str(e)})"

    async def _run_tool_async(self, tool_call: dict[str, Any]) -> str:
        name = _normalize_tool_name(tool_call["name"])
        arguments = tool_call.get("arguments", {})

        try:
            if name == "search_web":
                query = arguments.get("query") or arguments.get("q")
                if not query:
                    return "Error: query parameter is required"
                return await asyncio.to_thread(search_web, query)
            if name == "fetch_content":
                url = arguments.get("url")
                if not url:
                    return "Error: url parameter is required"
                return await asyncio.to_thread(fetch_content, url)
            return f"Error: Unknown tool '{name}'"
        except Exception as e:
            return f"Error: Local tool execution failed ({str(e)})"

    # API 用 (同期/一括生成)
    def run_chat(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.0,
        tools: list[str] | None = None,
    ) -> str:
        if self.model_manager is None:
            self.model_manager = get_model_manager()
            
        allowed_tools = {_normalize_tool_name(tool) for tool in (tools or [])}
        prepared_input_messages = [dict(message) for message in messages]
        
        # Repair mode check
        repair_data = None
        last_msg = _extract_text_content(prepared_input_messages[-1].get("content", "")) if prepared_input_messages else ""
        if last_msg:
            repair_data = detect_repair_json(last_msg)
            if repair_data:
                prepared_input_messages[-1]["content"] = format_repair_prompt(repair_data)

        prepared_messages = self._prepare_messages(prepared_input_messages, allow_tools=bool(allowed_tools))
        retried_plain_answer = False

        for _ in range(self.max_tool_rounds + 1):
            raw_response = "".join(
                self.model_manager.generate_stream(
                    prepared_messages,
                    model=model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            )

            tool_call = self.parse_tool_call(raw_response)
            if tool_call and _normalize_tool_name(tool_call["name"]) in allowed_tools:
                # API context uses sync tool call (already threaded in API route normally, but here we use search_web directly)
                name = _normalize_tool_name(tool_call["name"])
                args = tool_call.get("arguments", {})
                if name == "search_web": tool_result = search_web(args.get("query", ""))
                elif name == "fetch_content": tool_result = fetch_content(args.get("url", ""))
                else: tool_result = f"Error: Unknown tool {name}"
                
                prepared_messages.append({"role": "assistant", "content": raw_response.strip()})
                prepared_messages.append({"role": "user", "content": f"（検索結果）\n{tool_result}\n回答を続けてください。"})
                continue

            sanitized = self.sanitize_response(raw_response, force_json=bool(repair_data))
            if sanitized: return sanitized
            if tool_call: return f"Tool '{tool_call['name']}' is unavailable for this request."

            if not retried_plain_answer:
                retried_plain_answer = True
                prepared_messages.append({"role": "assistant", "content": raw_response.strip()})
                prepared_messages.append({"role": "user", "content": "思考過程やタグを出力せず、最終回答のみを返してください。"})
                continue
            return "回答を生成できませんでした。"
        return "上限に達しました。"

    # CLI 単発実行用 (セッション履歴を維持)
    def run_turn(
        self,
        user_input: str,
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> str:
        # Repair mode check
        repair_data = detect_repair_json(user_input)
        if repair_data:
            user_input = format_repair_prompt(repair_data)
            
        self.add_message("user", user_input)
        retried_plain_answer = False

        for _ in range(self.max_tool_rounds + 1):
            raw_response = "".join(
                self.model_manager.generate_stream(
                    self.messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            )

            tool_call = self.parse_tool_call(raw_response)
            if tool_call:
                if self.verbose: # -v の時だけ詳細を表示
                    print(f"\n[Searching: {tool_call['name']}...]", flush=True)
                
                tool_result = self._run_tool_sync(tool_call)
                self.add_message("assistant", raw_response.strip())
                self.add_message("user", f"（検索結果）\n{tool_result}\nこの結果をもとに、回答を日本語で生成してください。")
                continue

            sanitized = self.sanitize_response(raw_response, force_json=bool(repair_data))
            if sanitized:
                self.add_message("assistant", raw_response.strip())
                return sanitized

            if not retried_plain_answer:
                retried_plain_answer = True
                self.add_message("assistant", raw_response.strip())
                self.add_message("user", "思考過程やタグを出力せず、最終回答のみを返してください。")
                continue

            self.add_message("assistant", raw_response.strip())
            return "回答を生成できませんでした。"

        self.add_message("assistant", "上限に達しました。")
        return "上限に達しました。"

    # CLI 用 (ストリーミング対話)
    async def chat_loop(self, user_input: str, **kwargs):
        self.add_message("user", user_input)
        
        while True:
            print("Assistant: ", end="", flush=True)
            full_resp = ""
            is_thinking = False
            is_tool_calling_detected = False
            
            think_start_tags = ["<|channel>thought", "<think>"]
            think_end_tags = ["<channel|>", "</think>"]
            buffer = ""
            
            # self.model_manager が generate_stream を持っていることを期待 (Backends or ModelManager)
            for chunk in self.model_manager.generate_stream(self.messages, **kwargs):
                full_resp += chunk
                buffer += chunk

                # 【DEBUG】verbose時は生の出力をstderr等に吐き出す
                if self.verbose:
                    # 改行や特殊文字を可視化しつつ出力
                    print(f"\033[90m{chunk}\033[0m", end="", flush=True)

                for t in think_start_tags:
                    if t in buffer:
                        if not is_thinking:
                            pre_text = buffer[:buffer.find(t)]
                            if pre_text and not self.verbose: print(pre_text, end="", flush=True)
                            is_thinking = True
                            if not self.verbose: print("[Thinking...]", end="", flush=True)
                        buffer = buffer[buffer.find(t) + len(t):]

                for t in think_end_tags:
                    if t in buffer:
                        if is_thinking:
                            is_thinking = False
                            if not self.verbose: print(" Done.\n", end="", flush=True)
                        buffer = buffer[buffer.find(t) + len(t):]

                if ("<|tool_call|>" in full_resp or "<tool_call>" in full_resp) and self.parse_tool_call(full_resp):
                    is_tool_calling_detected = True
                    if self.verbose:
                        print("[Searching...]", end="", flush=True)
                    break

                if is_thinking and not self.verbose:
                    if len(buffer) > 100: buffer = buffer[-50:]
                else:
                    if "<" in buffer:
                        safe_idx = buffer.find("<")
                        if safe_idx > 0:
                            if not self.verbose: print(buffer[:safe_idx], end="", flush=True)
                            buffer = buffer[safe_idx:]
                        # バッファが長すぎる場合はタグではないと判断して出力
                        # 検索クエリが長い場合に備え、上限を 500 文字に拡張
                        if len(buffer) > 500:
                            if not self.verbose: print(buffer, end="", flush=True)
                            buffer = ""
                    else:
                        if not self.verbose: print(buffer, end="", flush=True)
                        buffer = ""
                await asyncio.sleep(0)

            if not is_tool_calling_detected:
                print("", flush=True)
            call = self.parse_tool_call(full_resp)
            if call:
                if not is_tool_calling_detected and self.verbose:
                    print("[Searching...]", flush=True)
                tool_res = await self._run_tool_async(call)
                self.add_message("assistant", full_resp.strip())
                self.add_message("user", f"（検索結果）\n{tool_res}\nこの結果をもとに、回答を日本語で生成してください。")
                continue
            
            self.add_message("assistant", full_resp.strip())
            break
        print("\n")
