import fs from 'node:fs/promises';
import path from 'node:path';
import { type ReviewMcpToolCaller, callReviewMcpTool } from '../mcp/caller.js';
import type { Finding, FixSuggestion } from '../types.js';

const FIXABLE_CATEGORIES = new Set<Finding['category']>([
  'unused-import',
  'missing-import',
  'missing-parameter',
  'interface-property',
]);

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getMetadataStrings(metadata: Record<string, unknown> | undefined, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function isFixable(finding: Finding): boolean {
  return FIXABLE_CATEGORIES.has(finding.category) && finding.confidence !== 'low';
}

export function buildPatchOperation(finding: Finding): Record<string, unknown> | null {
  const metadata = finding.metadata ?? {};

  switch (finding.category) {
    case 'unused-import':
      if (!getMetadataString(metadata, 'module')) return null;
      return {
        type: 'remove_import',
        file: finding.file_path,
        module: getMetadataString(metadata, 'module'),
      };
    case 'missing-import': {
      const module = getMetadataString(metadata, 'module');
      const specifiers = getMetadataStrings(metadata, 'specifiers');
      if (!module || specifiers.length === 0) return null;
      return {
        type: 'add_import',
        file: finding.file_path,
        module,
        specifiers,
      };
    }
    case 'missing-parameter': {
      const functionName = getMetadataString(metadata, 'functionName');
      const paramName = getMetadataString(metadata, 'paramName');
      if (!functionName || !paramName) return null;
      return {
        type: 'update_function',
        file: finding.file_path,
        name: functionName,
        changes: {
          add_param: {
            name: paramName,
            type: getMetadataString(metadata, 'paramType') ?? 'unknown',
          },
        },
      };
    }
    case 'interface-property': {
      const interfaceName = getMetadataString(metadata, 'interfaceName');
      const propertyName = getMetadataString(metadata, 'propertyName');
      if (!interfaceName || !propertyName) return null;
      return {
        type: 'update_interface',
        file: finding.file_path,
        name: interfaceName,
        changes: {
          add_property: {
            name: propertyName,
            type: getMetadataString(metadata, 'propertyType') ?? 'unknown',
          },
        },
      };
    }
    default:
      return null;
  }
}

type AstmendPatchResult = {
  success?: boolean;
  diff?: string;
  updatedText?: string;
  rejects?: Array<{ reason?: string }>;
};

export async function generateFixSuggestion(
  finding: Finding,
  projectRoot: string,
  caller?: ReviewMcpToolCaller,
): Promise<FixSuggestion | null> {
  if (!isFixable(finding)) return null;

  const operation = buildPatchOperation(finding);
  if (!operation) return null;

  try {
    const root = path.resolve(projectRoot);
    const filePath = path.resolve(root, finding.file_path);
    const relativePath = path.relative(root, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;

    const sourceText = await fs.readFile(filePath, 'utf8');
    const result = await callReviewMcpTool<AstmendPatchResult>(
      caller,
      'mcp_astmend_apply_patch_to_text',
      {
        operation,
        sourceText,
      },
    );

    if (!result?.success || !result.diff || !result.updatedText) return null;

    return {
      findingId: finding.id,
      operation,
      diff: result.diff,
      updatedText: result.updatedText,
      confidence: result.rejects?.length ? 'medium' : 'high',
    };
  } catch {
    return null;
  }
}
