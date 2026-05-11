import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAlias,
  resolveLauncherPlan,
  resolveLocalLlmConcurrencyLimit,
} from '../src/scripts/local-llm-cli.js';

const ROOT_DIR = process.cwd();

const readText = (relativePath: string): string =>
  fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');

describe('local LLM CLI launchers', () => {
  test('package scripts expose command wrappers', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.gemma4).toBe('./scripts/gemma4');
    expect(packageJson.scripts?.qwen).toBe('./scripts/qwen');
    expect(packageJson.scripts?.bonsai).toBe('./scripts/bonsai');
    expect(packageJson.scripts?.bedrock).toBe('./scripts/bedrock');
    expect(packageJson.scripts?.openai).toBe('./scripts/openai');
  });

  test('root wrappers delegate to the canonical scripts', () => {
    expect(readText('scripts/gemma4')).toContain('src/scripts/local-llm-cli.ts');
    expect(readText('scripts/qwen')).toContain('src/scripts/local-llm-cli.ts');
    expect(readText('scripts/bonsai')).toContain('src/scripts/local-llm-cli.ts');
    expect(readText('scripts/bedrock')).toContain('src/scripts/local-llm-cli.ts');
    expect(readText('scripts/openai')).toContain('src/scripts/local-llm-cli.ts');
  });

  test('alias router resolves each launcher to the expected runtime', () => {
    expect(parseAlias(['--alias', 'gemma4'])).toBe('gemma4');
    expect(parseAlias(['--alias', 'qwen'])).toBe('qwen');
    expect(resolveLauncherPlan('gemma4', ['--prompt', 'hello']).command).toContain(
      '/local-llm/scripts/gemma4',
    );
    expect(resolveLauncherPlan('qwen', ['--prompt', 'hello']).command).toContain(
      '/local-llm/scripts/qwen',
    );
    expect(resolveLauncherPlan('qwen', ['--prompt', 'hello']).args.join(' ')).toContain(
      'Qwen3-14B-4bit',
    );
    expect(resolveLauncherPlan('bonsai', ['--prompt', 'hello']).command).toContain(
      '/local-llm/scripts/bonsai',
    );
    expect(resolveLauncherPlan('bonsai', ['--prompt', 'hello']).args.join(' ')).toContain(
      'prism-ml/Ternary-Bonsai-8B-mlx-2bit',
    );
    expect(resolveLauncherPlan('openai', ['--prompt', 'hello']).args.join(' ')).toContain(
      '--provider openai',
    );
    expect(resolveLauncherPlan('bedrock', ['--prompt', 'hello']).args.join(' ')).toContain(
      '--provider bedrock',
    );
    expect(
      resolveLauncherPlan('openai', ['--session-id', 'sess_123456', '--mcp']).args.join(' '),
    ).toContain('--session-id sess_123456');
    expect(resolveLauncherPlan('bedrock', ['--no-mcp']).args.join(' ')).toContain('--no-mcp');
    expect(resolveLauncherPlan('gemma4', ['--model', 'custom-model']).args.join(' ')).toContain(
      'custom-model',
    );
    expect(
      resolveLauncherPlan('gemma4', [
        '--mtp',
        '--draft-model',
        'mlx-community/gemma-4-E4B-it-assistant-bf16',
        '--draft-block-size',
        '6',
      ]).args.join(' '),
    ).toContain('--mtp --draft-model mlx-community/gemma-4-E4B-it-assistant-bf16');
  });

  test('local runtime defaults stay on external sibling repository', () => {
    const constants = readText('src/constants.ts');
    expect(constants).toContain("../local-llm/scripts/gemma4");
    expect(constants).toContain("../local-llm/scripts/qwen");
    expect(constants).toContain("../local-llm/scripts/bonsai");
    expect(constants).toContain("EMBED_COMMAND_DEFAULT: 'embed'");
  });

  test('local LLM concurrency is capped at one process', () => {
    expect(resolveLocalLlmConcurrencyLimit({})).toBe(1);
    expect(resolveLocalLlmConcurrencyLimit({ GNOSIS_LLM_CONCURRENCY_LIMIT: '1' })).toBe(1);
    expect(resolveLocalLlmConcurrencyLimit({ GNOSIS_LLM_CONCURRENCY_LIMIT: '4' })).toBe(1);
    expect(resolveLocalLlmConcurrencyLimit({ GNOSIS_LLM_CONCURRENCY_LIMIT: 'invalid' })).toBe(1);
  });

  test('PATH helpers include all command names', () => {
    const reg = readText('scripts/register-path.sh');
    expect(reg).toContain('ROOT_SCRIPTS');
    expect(reg).toContain('which gemma4');
    expect(reg).toContain('which qwen');
    expect(reg).toContain('which bonsai');
    expect(reg).toContain('which bedrock');
    expect(reg).toContain('which openai');
  });

  test('setup guidance references external local-llm runtime wiring', () => {
    const setup = readText('scripts/setup-services.sh');
    expect(setup).toContain('GNOSIS_LOCAL_LLM_PATH');
    expect(setup).toContain('scripts/setup.sh');
    expect(setup).toContain('scripts/register-path.sh');
    expect(setup).toContain('bootstrap:local-llm');
  });
});
