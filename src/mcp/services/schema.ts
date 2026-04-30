import { zodToJsonSchema } from 'zod-to-json-schema';

const TOP_LEVEL_PROHIBITED_SCHEMA_KEYS = ['anyOf', 'oneOf', 'allOf', 'enum', 'not'] as const;

function cloneSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, rawPart) => {
      if (!current || typeof current !== 'object') return undefined;
      const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
      return (current as Record<string, unknown>)[part];
    }, root);
}

function dereferenceTopLevelRefs(
  root: Record<string, unknown>,
  value: unknown,
  seen = new Set<string>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dereferenceTopLevelRefs(root, item, seen));
  }
  if (!value || typeof value !== 'object') return value;

  const object = value as Record<string, unknown>;
  if (typeof object.$ref === 'string') {
    if (seen.has(object.$ref)) return {};
    seen.add(object.$ref);
    const resolved = resolveLocalRef(root, object.$ref);
    return dereferenceTopLevelRefs(root, resolved, seen);
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, dereferenceTopLevelRefs(root, item, seen)]),
  );
}

function mergePropertySchemas(
  existing: unknown,
  incoming: unknown,
  root: Record<string, unknown>,
): unknown {
  const left = dereferenceTopLevelRefs(root, existing);
  const right = dereferenceTopLevelRefs(root, incoming);
  if (!left) return right;
  if (!right) return left;

  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  if (JSON.stringify(leftObject) === JSON.stringify(rightObject)) return leftObject;

  const literalValues = [
    ...(Array.isArray(leftObject.enum) ? leftObject.enum : []),
    ...(Array.isArray(rightObject.enum) ? rightObject.enum : []),
    leftObject.const,
    rightObject.const,
  ].filter((value) => value !== undefined);
  if (literalValues.length > 0) {
    return {
      type: leftObject.type ?? rightObject.type ?? 'string',
      enum: Array.from(new Set(literalValues)),
    };
  }

  if (leftObject.type && leftObject.type === rightObject.type) {
    return { ...leftObject, ...rightObject };
  }

  return {};
}

function normalizeTopLevelObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const variants = (schema.anyOf ?? schema.oneOf ?? schema.allOf) as unknown;
  if (Array.isArray(variants)) {
    const objectVariants = variants
      .map((variant) => dereferenceTopLevelRefs(schema, variant))
      .filter(
        (variant): variant is Record<string, unknown> =>
          !!variant &&
          typeof variant === 'object' &&
          !Array.isArray(variant) &&
          (variant as Record<string, unknown>).type === 'object',
      );

    if (objectVariants.length === variants.length) {
      const properties: Record<string, unknown> = {};
      let required: Set<string> | null = null;
      let additionalProperties: unknown = false;

      for (const variant of objectVariants) {
        const variantProperties =
          variant.properties && typeof variant.properties === 'object'
            ? (variant.properties as Record<string, unknown>)
            : {};
        for (const [key, value] of Object.entries(variantProperties)) {
          properties[key] = mergePropertySchemas(properties[key], value, schema);
        }

        const requiredValues: string[] = Array.isArray(variant.required)
          ? variant.required.filter((value): value is string => typeof value === 'string')
          : [];
        const requiredSet = new Set<string>(requiredValues);
        required =
          required === null
            ? requiredSet
            : new Set<string>(
                Array.from(required as Set<string>).filter((value) => requiredSet.has(value)),
              );

        if (variant.additionalProperties !== false) additionalProperties = true;
      }

      return {
        type: 'object',
        properties,
        required: [...(required ?? new Set<string>())],
        additionalProperties,
      };
    }
  }

  const normalized = cloneSchema(schema);
  for (const key of TOP_LEVEL_PROHIBITED_SCHEMA_KEYS) {
    delete normalized[key];
  }
  normalized.type = 'object';
  if (!normalized.properties || typeof normalized.properties !== 'object') {
    normalized.additionalProperties = true;
  }
  return normalized;
}

export function zodInputSchemaToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    const jsonSchema = zodToJsonSchema(schema as never) as Record<string, unknown>;
    if (TOP_LEVEL_PROHIBITED_SCHEMA_KEYS.some((key) => key in jsonSchema)) {
      return normalizeTopLevelObjectSchema(jsonSchema);
    }
    if (jsonSchema.type !== 'object') {
      return normalizeTopLevelObjectSchema(jsonSchema);
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
