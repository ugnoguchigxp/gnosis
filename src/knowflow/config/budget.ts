import { z } from 'zod';

const envNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const BudgetConfigSchema = z
  .object({
    userBudget: z.number().int().positive(),
    cronBudget: z.number().int().positive(),
    cronRunBudget: z.number().int().positive(),
  })
  .strict();

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const loadBudgetConfigFromEnv = (override: Partial<BudgetConfig> = {}): BudgetConfig => {
  return BudgetConfigSchema.parse({
    userBudget: envNumber(process.env.USER_BUDGET, 12),
    cronBudget: envNumber(process.env.CRON_BUDGET, 6),
    cronRunBudget: envNumber(process.env.CRON_RUN_BUDGET, 30),
    ...override,
  });
};
