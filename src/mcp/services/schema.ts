import { zodToJsonSchema } from 'zod-to-json-schema';

export function zodInputSchemaToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    const jsonSchema = zodToJsonSchema(schema as never) as Record<string, unknown>;
    if (
      !jsonSchema.type &&
      (Array.isArray(jsonSchema.anyOf) ||
        Array.isArray(jsonSchema.oneOf) ||
        Array.isArray(jsonSchema.allOf))
    ) {
      return {
        ...jsonSchema,
        type: 'object',
      };
    }
    return jsonSchema;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: 'object',
      additionalProperties: true,
      description: `Schema conversion failed; accepting object input. ${message}`,
    };
  }
}

const stringArraySchema = {
  type: 'array',
  items: { type: 'string' },
};

const diffGuardCommonProperties = {
  workspaceRoot: { type: 'string' },
  configPath: { type: 'string' },
  pluginPaths: stringArraySchema,
  llmRelatedCode: { type: 'string' },
  enableLlm: { type: 'boolean' },
  format: { type: 'string', enum: ['json', 'sarif'] },
};

export function diffGuardInputSchemaToJsonSchema(toolName: string): Record<string, unknown> {
  if (toolName === 'analyze_diff') {
    return {
      type: 'object',
      properties: {
        diff: { type: 'string' },
      },
      required: ['diff'],
      additionalProperties: false,
    };
  }

  if (toolName === 'review_diff') {
    return {
      type: 'object',
      properties: {
        diff: { type: 'string' },
        files: stringArraySchema,
        sourceFilePaths: stringArraySchema,
        ...diffGuardCommonProperties,
      },
      required: ['diff'],
      additionalProperties: false,
    };
  }

  if (toolName === 'review_batch') {
    return {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              diff: { type: 'string' },
              files: stringArraySchema,
            },
            required: ['diff'],
            additionalProperties: false,
          },
          minItems: 1,
        },
        ...diffGuardCommonProperties,
      },
      required: ['items'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    additionalProperties: true,
  };
}
