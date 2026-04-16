import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

const readText = (relativePath: string): string =>
  fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');

describe('local LLM CLI launchers', () => {
  test('package scripts expose the four command wrappers', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.gemma4).toBe('./scripts/gemma4');
    expect(packageJson.scripts?.bonsai).toBe('./scripts/bonsai');
    expect(packageJson.scripts?.bedrock).toBe('./scripts/bedrock');
    expect(packageJson.scripts?.openai).toBe('./scripts/openai');
  });

  test('root wrappers delegate to the canonical scripts', () => {
    expect(readText('scripts/gemma4')).toContain('services/local-llm/scripts/gemma4');
    expect(readText('scripts/bonsai')).toContain('services/local-llm/scripts/bonsai');
    expect(readText('scripts/bedrock')).toContain('services/local-llm/scripts/bedrock');
    expect(readText('scripts/openai')).toContain('services/local-llm/scripts/openai');
    expect(readText('services/local-llm/scripts/openai')).toContain('--provider openai');
  });

  test('PATH helpers include all command names', () => {
    expect(readText('scripts/register-path.sh')).toContain('ROOT_SCRIPTS');
    expect(readText('scripts/register-path.sh')).toContain('which gemma4');
    expect(readText('scripts/register-path.sh')).toContain('which bonsai');
    expect(readText('scripts/register-path.sh')).toContain('which bedrock');
    expect(readText('scripts/register-path.sh')).toContain('which openai');
    expect(readText('services/local-llm/scripts/install_path.sh')).toContain(
      "To use 'gemma4', 'ollama-v4', 'bonsai', 'bedrock', and 'openai' commands from anywhere",
    );
  });

  test('setup guidance references all four launchers', () => {
    expect(readText('scripts/setup-services.sh')).toContain('scripts/gemma4');
    expect(readText('scripts/setup-services.sh')).toContain('scripts/bonsai');
    expect(readText('scripts/setup-services.sh')).toContain('scripts/bedrock');
    expect(readText('scripts/setup-services.sh')).toContain('scripts/openai');
  });
});
