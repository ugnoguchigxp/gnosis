import { describe, expect, test } from 'bun:test';
import { parseGitNameStatusZ } from '../scripts/fresh-clone-value-smoke.js';

const z = (values: string[]): string => `${values.join('\0')}\0`;

describe('fresh clone value smoke overlay parsing', () => {
  test('parses rename and copy records from git name-status -z output', () => {
    const records = parseGitNameStatusZ(
      z([
        'M',
        'src/changed.ts',
        'R100',
        'src/old.ts',
        'src/new.ts',
        'C075',
        'src/template.ts',
        'src/copy.ts',
        'D',
        'src/deleted.ts',
      ]),
    );

    expect(records).toEqual([
      { status: 'M', path: 'src/changed.ts' },
      { status: 'R100', oldPath: 'src/old.ts', path: 'src/new.ts' },
      { status: 'C075', oldPath: 'src/template.ts', path: 'src/copy.ts' },
      { status: 'D', path: 'src/deleted.ts' },
    ]);
  });

  test('rejects malformed rename records instead of overlaying the wrong path', () => {
    expect(() => parseGitNameStatusZ(z(['R100', 'src/old.ts']))).toThrow(
      'Malformed git name-status record',
    );
  });
});
