type Primitive = string | number | boolean | null | undefined;

export type OutputFormat = 'json' | 'table';

export const resolveOutputFormat = (args: Record<string, string | boolean>): OutputFormat => {
  const json = args.json === true;
  const table = args.table === true;
  if (json && table) {
    throw new Error('--json and --table cannot be used together');
  }
  if (table) {
    return 'table';
  }
  return 'json';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const primitiveToString = (value: Primitive): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return String(value);
};

const flatten = (value: unknown, prefix = ''): Array<{ field: string; value: Primitive }> => {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [{ field: prefix || '(value)', value: '[]' }];
    }
    const rows: Array<{ field: string; value: Primitive }> = [];
    for (let index = 0; index < value.length; index += 1) {
      const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      rows.push(...flatten(value[index], nextPrefix));
    }
    return rows;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [{ field: prefix || '(value)', value: '{}' }];
    }

    const rows: Array<{ field: string; value: Primitive }> = [];
    for (const [key, nestedValue] of entries) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      rows.push(...flatten(nestedValue, nextPrefix));
    }
    return rows;
  }

  return [{ field: prefix || '(value)', value: value as Primitive }];
};

const renderKeyValueTable = (rows: Array<{ field: string; value: Primitive }>): string => {
  if (rows.length === 0) {
    return '(no rows)\n';
  }
  const headers = ['field', 'value'] as const;
  const fieldWidth = Math.max(headers[0].length, ...rows.map((row) => row.field.length));
  const valueWidth = Math.max(
    headers[1].length,
    ...rows.map((row) => primitiveToString(row.value).length),
  );
  const line = `+-${'-'.repeat(fieldWidth)}-+-${'-'.repeat(valueWidth)}-+`;

  const body = rows.map(
    (row) =>
      `| ${row.field.padEnd(fieldWidth)} | ${primitiveToString(row.value).padEnd(valueWidth)} |`,
  );

  return [
    line,
    `| ${headers[0].padEnd(fieldWidth)} | ${headers[1].padEnd(valueWidth)} |`,
    line,
    ...body,
    line,
    '',
  ].join('\n');
};

export const renderOutput = (payload: unknown, format: OutputFormat): string => {
  if (format === 'json') {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  const rows = flatten(payload);
  return renderKeyValueTable(rows);
};
