import path from 'node:path';
import { type ReviewMcpToolCaller, callReviewMcpTool } from '../mcp/caller.js';
import type { AstmendImpactSummary, AstmendSymbolImpact, NormalizedDiff } from '../types.js';

export interface ChangedSymbol {
  name: string;
  kind: 'function' | 'interface' | 'class' | 'type_alias' | 'enum' | 'variable';
  file: string;
}

type AstmendReferencesResponse = {
  references?: Array<Record<string, unknown>>;
};

type AstmendImpactResponse = {
  result?: Array<Record<string, unknown>>;
  impactedDeclarations?: Array<Record<string, unknown>>;
};

function uniqueSymbols(symbols: ChangedSymbol[]): ChangedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.file}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractChangedSymbols(diffs: NormalizedDiff[]): ChangedSymbol[] {
  const symbols: ChangedSymbol[] = [];
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
  const interfacePattern = /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
  const classPattern = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/;
  const typeAliasPattern = /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/;
  const enumPattern = /(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/;
  const variablePattern = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=|:)/;

  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      const changedLines = hunk.lines.filter((line) => line.type !== 'context');
      for (const line of changedLines) {
        const content = line.content;
        const patterns: Array<[RegExp, ChangedSymbol['kind']]> = [
          [functionPattern, 'function'],
          [interfacePattern, 'interface'],
          [classPattern, 'class'],
          [typeAliasPattern, 'type_alias'],
          [enumPattern, 'enum'],
          [variablePattern, 'variable'],
        ];

        for (const [pattern, kind] of patterns) {
          const match = content.match(pattern);
          if (match?.[1]) {
            symbols.push({ name: match[1], kind, file: diff.filePath });
            break;
          }
        }
      }
    }
  }

  return uniqueSymbols(symbols);
}

function normalizeReferences(
  result: AstmendReferencesResponse | null,
  fallbackFile: string,
): AstmendSymbolImpact['references'] {
  const rawReferences = result?.references ?? [];
  const normalizedReferences: Array<{ file: string; line: number; isDefinition: boolean }> = [];

  for (const reference of rawReferences) {
    const normalized = {
      file: String(reference.file ?? reference.filePath ?? fallbackFile),
      line: typeof reference.line === 'number' ? reference.line : Number(reference.line ?? 0),
      isDefinition: Boolean(reference.isDefinition),
    };

    if (normalized.file && normalized.line > 0) {
      normalizedReferences.push(normalized);
    }
  }

  return normalizedReferences;
}

function normalizeImpactedDeclarations(
  result: AstmendImpactResponse | null,
  fallbackFile: string,
): AstmendSymbolImpact['impactedDeclarations'] {
  const rawDeclarations = result?.result ?? result?.impactedDeclarations ?? [];

  const normalizedDeclarations: Array<{ name: string; kind: string; file: string }> = [];

  for (const declaration of rawDeclarations) {
    const normalized = {
      name: String(declaration.name ?? ''),
      kind: String(declaration.kind ?? 'variable'),
      file: String(declaration.file ?? declaration.filePath ?? fallbackFile),
    };

    if (normalized.name && normalized.file) {
      normalizedDeclarations.push(normalized);
    }
  }

  return normalizedDeclarations;
}

export async function analyzeImpactWithAstmend(
  symbols: ChangedSymbol[],
  projectRoot: string,
  caller?: ReviewMcpToolCaller,
): Promise<AstmendImpactSummary> {
  if (symbols.length === 0) {
    return { symbols: [], degraded: false };
  }

  const results: AstmendSymbolImpact[] = [];

  for (const symbol of symbols) {
    const filePath = path.join(projectRoot, symbol.file);

    const [referencesResult, impactResult] = await Promise.all([
      callReviewMcpTool<AstmendReferencesResponse>(
        caller,
        'mcp_astmend_analyze_references_from_file',
        {
          filePath,
          target: { kind: symbol.kind, name: symbol.name },
        },
      ),
      callReviewMcpTool<AstmendImpactResponse>(caller, 'mcp_astmend_detect_impact_from_file', {
        filePath,
        target: { kind: symbol.kind, name: symbol.name },
      }),
    ]);

    if (!referencesResult && !impactResult) continue;

    results.push({
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      references: normalizeReferences(referencesResult, symbol.file),
      impactedDeclarations: normalizeImpactedDeclarations(impactResult, symbol.file),
    });
  }

  return {
    symbols: results,
    degraded: results.length === 0 && symbols.length > 0,
  };
}

export function buildImpactSection(impact: AstmendImpactSummary): string {
  if (impact.degraded) {
    return '## 影響範囲解析\n\n（Astmend MCP 利用不可のため省略）\n';
  }

  if (impact.symbols.length === 0) {
    return '## 影響範囲解析\n\n（変更シンボルは検出されませんでした）\n';
  }

  const lines = ['## 影響範囲解析（Astmend AST 解析結果）', ''];

  for (const symbol of impact.symbols) {
    lines.push(`### ${symbol.kind} \`${symbol.name}\` (${symbol.file})`);
    lines.push(`- 参照箇所: ${symbol.references.length} 件`);

    const externalRefs = symbol.references.filter((reference) => reference.file !== symbol.file);
    if (externalRefs.length > 0) {
      lines.push('- **外部参照** (追従漏れ注意):');
      for (const reference of externalRefs.slice(0, 10)) {
        lines.push(`  - ${reference.file}:${reference.line}`);
      }
    }

    if (symbol.impactedDeclarations.length > 0) {
      lines.push('- **影響を受ける宣言**:');
      for (const declaration of symbol.impactedDeclarations.slice(0, 10)) {
        lines.push(`  - ${declaration.kind} \`${declaration.name}\` (${declaration.file})`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
