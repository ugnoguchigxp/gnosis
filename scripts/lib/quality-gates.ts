import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type QualityGateState = 'passed' | 'failed' | 'unknown';

export type QualityGateRecord = {
  status: QualityGateState;
  updatedAt: string | null;
  message: string | null;
};

export type QualityGateName =
  | 'doctor'
  | 'doctorStrict'
  | 'onboardingSmoke'
  | 'smoke'
  | 'verifyFast'
  | 'verify'
  | 'verifyStrict'
  | 'mcpContract';

export type QualityGateFile = Partial<Record<QualityGateName, QualityGateRecord>>;

const QUALITY_GATES_PATH = path.join(process.cwd(), 'logs', 'quality-gates.json');

function readQualityGateFile(): QualityGateFile {
  if (!existsSync(QUALITY_GATES_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(QUALITY_GATES_PATH, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as QualityGateFile;
    }
  } catch {
    return {};
  }
  return {};
}

export function recordQualityGate(
  name: QualityGateName,
  status: Exclude<QualityGateState, 'unknown'>,
  message?: string,
): void {
  const current = readQualityGateFile();
  const next: QualityGateFile = {
    ...current,
    [name]: {
      status,
      updatedAt: new Date().toISOString(),
      message: message ?? null,
    },
  };
  mkdirSync(path.dirname(QUALITY_GATES_PATH), { recursive: true });
  writeFileSync(QUALITY_GATES_PATH, `${JSON.stringify(next, null, 2)}\n`);
}
