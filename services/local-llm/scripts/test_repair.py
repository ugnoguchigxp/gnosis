import sys
import os
import json

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core.chat_engine import ChatEngine
from backends.mock_backend import MockBackend

def test_repair_mode_detection():
    backend = MockBackend(verbose=False)
    engine = ChatEngine(backend, verbose=False)
    
    repair_json = {
        "task": {
            "scenarioId": "test-001",
            "instruction": "Fix the bug in main.py"
        },
        "feedback": {
            "attempt": 2,
            "previousRejects": [{"path": "main.py", "reason": "Syntax error"}],
            "previousIssues": [{"id": "E101", "level": "error", "message": "Missing semicolon"}]
        }
    }
    
    # CLI mode (run_turn)
    print("Testing CLI mode detection...")
    input_str = json.dumps(repair_json)
    resp = engine.run_turn(input_str)
    
    # The MockBackend returns "Mock response for: <last_user_message>"
    # In run_turn, the input was transformed into a prompt by ChatEngine before being sent to backend.
    
    assert "指示 (Instruction)" in resp
    assert "Fix the bug in main.py" in resp
    assert "試行回数: 2" in resp
    assert "Syntax error" in resp
    print("CLI mode detection: PASS")

def test_api_mode_detection():
    backend = MockBackend(verbose=False)
    engine = ChatEngine(backend, verbose=False)
    
    repair_json = {
        "task": {"instruction": "Enhance UI"},
        "feedback": {"attempt": 3, "previousIssues": []}
    }
    
    messages = [
        {"role": "user", "content": json.dumps(repair_json)}
    ]
    
    print("Testing API mode detection...")
    resp = engine.run_chat(messages, model="mock")
    
    assert "指示 (Instruction)" in resp
    assert "Enhance UI" in resp
    assert "試行回数: 3" in resp
    print("API mode detection: PASS")

def test_sanitization():
    # Test that code blocks are removed when force_json=True
    engine = ChatEngine()
    raw_resp = "Here is the JSON:\n```json\n{\"status\": \"ok\"}\n```\nHope it helps!"
    sanitized = engine.sanitize_response(raw_resp, force_json=True)
    print(f"Sanitized (force_json=True): {sanitized}")
    assert sanitized == "{\"status\": \"ok\"}"
    
    # Test that only full code blocks are removed when force_json=False
    raw_resp2 = "```json\n{\"status\": \"ok\"}\n```"
    sanitized2 = engine.sanitize_response(raw_resp2, force_json=False)
    print(f"Sanitized (force_json=False, fullmatch): {sanitized2}")
    assert sanitized2 == "{\"status\": \"ok\"}"
    
    # Test without markdown
    raw_resp3 = "  {\"status\": \"none\"}  "
    assert engine.sanitize_response(raw_resp3) == "{\"status\": \"none\"}"
    
    print("Sanitization: PASS")

def test_normal_text_regression():
    backend = MockBackend(verbose=False)
    engine = ChatEngine(backend, verbose=False)
    
    normal_input = "Hello, how are you?"
    print("Testing normal text regression...")
    resp = engine.run_turn(normal_input)
    assert resp == f"Mock response for: {normal_input}"
    print("Normal text regression: PASS")

def test_tools_mode_text_and_input_immutability():
    backend = MockBackend(verbose=False)
    engine = ChatEngine(backend, verbose=False)

    original_text = "Explain {curly braces} in plain words."
    messages = [{"role": "user", "content": original_text}]

    print("Testing tools mode text and message immutability...")
    resp = engine.run_chat(messages, model="mock", tools=["search_web"])

    assert resp == f"Mock response for: {original_text}"
    assert messages[0]["content"] == original_text
    print("Tools mode regression: PASS")

def test_fenced_json_repair_detection():
    backend = MockBackend(verbose=False)
    engine = ChatEngine(backend, verbose=False)

    repair_json = {
        "task": {"instruction": "Refactor parser"},
        "feedback": {"attempt": 4},
    }
    wrapped = "```json\n" + json.dumps(repair_json) + "\n```"

    print("Testing fenced JSON repair detection...")
    resp = engine.run_turn(wrapped)
    assert "指示 (Instruction)" in resp
    assert "Refactor parser" in resp
    assert "試行回数: 4" in resp
    print("Fenced JSON detection: PASS")

def test_tool_call_parsing_variants():
    print("Testing tool call parsing variants...")

    cases = [
        (
            "<|tool_call|>call:search_web{query:<|\"|>東京 天気<|\"|>}<tool_call|>",
            {"name": "search_web", "arguments": {"query": "東京 天気"}},
        ),
        (
            "<|tool_call|>call:search_web{query:<|\"|>東京 天気<|\"|>}<|tool_call|>",
            {"name": "search_web", "arguments": {"query": "東京 天気"}},
        ),
        (
            "<tool_call>call:fetch_content{url:\"https://example.com\"}</tool_call>",
            {"name": "fetch_content", "arguments": {"url": "https://example.com"}},
        ),
        (
            "<|tool_call|>{\"name\":\"web_search\",\"arguments\":{\"query\":\"today weather\"}}<|tool_call|>",
            {"name": "web_search", "arguments": {"query": "today weather"}},
        ),
    ]

    for raw, expected in cases:
        parsed = ChatEngine.parse_tool_call(raw)
        assert parsed is not None
        assert parsed["name"] == expected["name"]
        for key, value in expected["arguments"].items():
            assert parsed["arguments"].get(key) == value

    print("Tool call parsing variants: PASS")

if __name__ == "__main__":
    try:
        test_repair_mode_detection()
        test_api_mode_detection()
        test_sanitization()
        test_normal_text_regression()
        test_tools_mode_text_and_input_immutability()
        test_fenced_json_repair_detection()
        test_tool_call_parsing_variants()
        print("\nAll tests passed!")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\nTest failed: {e}")
        sys.exit(1)
