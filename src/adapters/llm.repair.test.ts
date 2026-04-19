import { describe, expect, it } from 'bun:test';

// テスト対象の関数を模倣（プライベート関数のため）
function repairJson(json: string): string {
  let repaired = json.trim();
  const quoteCount = (repaired.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    repaired += '"';
  }
  const stack: string[] = [];
  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === char) {
        stack.pop();
      }
    }
  }
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  return repaired;
}

describe('repairJson', () => {
  it('repairs missing closing brace', () => {
    const input = '{"key": "value"';
    expect(JSON.parse(repairJson(input))).toEqual({ key: 'value' });
  });

  it('repairs missing closing bracket and brace', () => {
    const input = '{"items": ["a", "b"';
    expect(JSON.parse(repairJson(input))).toEqual({ items: ['a', 'b'] });
  });

  it('repairs unclosed quote and braces', () => {
    const input = '{"key": "val';
    expect(JSON.parse(repairJson(input))).toEqual({ key: 'val' });
  });

  it('handles complex nesting', () => {
    const input = '{"a": {"b": [1, 2';
    expect(JSON.parse(repairJson(input))).toEqual({ a: { b: [1, 2] } });
  });
});
