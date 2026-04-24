import type { ExperienceLesson } from '../experience.js';
import { recallExperienceLessons } from '../experience.js';
import type { ProcedureResult } from '../procedure.js';
import { type QueryProcedureOptions, queryProcedure } from '../procedure.js';

export interface GenerateImplementationPlanInput extends QueryProcedureOptions {
  goal: string;
  sessionId?: string;
  lessonQuery?: string;
  includeLessons?: boolean;
}

export interface ImplementationPlanItem {
  id: string;
  name: string;
  description: string;
  confidence: number;
  isGoldenPath: boolean;
  order: number;
  validationCriteria: string[];
  cautionNotes: string[];
}

export interface GeneratedImplementationPlan {
  goal: {
    id: string;
    name: string;
    description: string;
  };
  constraints: ProcedureResult['constraints'];
  tasks: ImplementationPlanItem[];
  lessons: ExperienceLesson[];
  reviewChecklist: string[];
  markdown: string;
}

function derivePlanningSessionId(input: GenerateImplementationPlanInput): string {
  if (input.sessionId?.trim()) return input.sessionId.trim();
  if (input.project?.trim()) return `planning-${input.project.trim()}`;
  if (input.repo?.trim()) return `planning-${input.repo.trim()}`;
  return 'planning-default';
}

function buildTaskCautionNotes(
  taskId: string,
  constraints: ProcedureResult['constraints'],
): string[] {
  return constraints
    .filter((constraint) => constraint.id === `caution:${taskId}`)
    .map((constraint) => constraint.description);
}

function buildMarkdown(
  plan: Omit<GeneratedImplementationPlan, 'markdown'>,
  goalText: string,
): string {
  const lines: string[] = [];
  lines.push('# Implementation Plan');
  lines.push('');
  lines.push(`- Goal: ${goalText}`);
  lines.push(`- Procedure Goal: ${plan.goal.name}`);
  lines.push('');
  lines.push('## Tasks');
  if (plan.tasks.length === 0) {
    lines.push('- (no task candidates)');
  } else {
    for (const task of plan.tasks) {
      const confidenceLabel = task.confidence.toFixed(2);
      const golden = task.isGoldenPath ? ' [Golden Path]' : '';
      lines.push(
        `${task.order + 1}. [ ] ${task.name}${golden} (confidence=${confidenceLabel}, id=${
          task.id
        })`,
      );
      if (task.description) lines.push(`   - ${task.description}`);
      for (const criterion of task.validationCriteria) {
        lines.push(`   - Validation: ${criterion}`);
      }
      for (const caution of task.cautionNotes) {
        lines.push(`   - Caution: ${caution}`);
      }
    }
  }
  lines.push('');
  lines.push('## Constraints');
  if (plan.constraints.length === 0) {
    lines.push('- (none)');
  } else {
    for (const constraint of plan.constraints) {
      lines.push(`- [${constraint.severity}] ${constraint.name}: ${constraint.description}`);
    }
  }

  lines.push('');
  lines.push('## Lessons');
  if (plan.lessons.length === 0) {
    lines.push('- (none)');
  } else {
    for (const lesson of plan.lessons) {
      const header = `- Failure: ${lesson.failure.content.slice(0, 120)}`;
      lines.push(header);
      if (lesson.solutions.length === 0) {
        lines.push('  - Solution: (no linked success)');
        continue;
      }
      for (const solution of lesson.solutions.slice(0, 3)) {
        lines.push(`  - Solution: ${solution.content.slice(0, 160)}`);
      }
    }
  }
  lines.push('');
  lines.push('## Review Checklist');
  for (const item of plan.reviewChecklist) {
    lines.push(`- ${item}`);
  }
  return lines.join('\n');
}

export async function generateImplementationPlan(
  input: GenerateImplementationPlanInput,
): Promise<GeneratedImplementationPlan | null> {
  const procedure = await queryProcedure(input.goal, {
    context: input.context,
    project: input.project,
    domains: input.domains,
    languages: input.languages,
    frameworks: input.frameworks,
    environment: input.environment,
    repo: input.repo,
  });
  if (!procedure) return null;

  const includeLessons = input.includeLessons !== false;
  const lessons = includeLessons
    ? await recallExperienceLessons(
        derivePlanningSessionId(input),
        input.lessonQuery?.trim() || input.goal,
        5,
      ).catch(() => [])
    : [];

  const tasks = procedure.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    description: task.description,
    confidence: task.confidence,
    isGoldenPath: task.isGoldenPath,
    order: task.order,
    validationCriteria: task.validationCriteria ?? [],
    cautionNotes: buildTaskCautionNotes(task.id, procedure.constraints),
  }));

  const planWithoutMarkdown = {
    goal: procedure.goal,
    constraints: procedure.constraints,
    tasks,
    lessons,
    reviewChecklist: [
      'verify constraints are reflected in each task',
      'explicitly include mitigations for caution tasks',
      'define acceptance criteria for all Golden Path tasks',
    ],
  };

  return {
    ...planWithoutMarkdown,
    markdown: buildMarkdown(planWithoutMarkdown, input.goal),
  };
}
