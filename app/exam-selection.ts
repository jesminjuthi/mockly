export type ExamSelectionMode = "combined" | "individual";

export type BankSelectionRule = {
  count: number;
  randomOrder: boolean;
};

type SelectableQuestion = {
  sourceId: string;
  order: number;
};

function shuffled<T>(items: T[], random: () => number) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function combinedFromSources<T extends SelectableQuestion>(
  questions: T[],
  sourceIds: string[],
  randomOrder: boolean,
  random: () => number,
) {
  const activeSourceIds = sourceIds.filter((sourceId) =>
    questions.some((question) => question.sourceId === sourceId),
  );
  const orderedSourceIds = randomOrder ? shuffled(activeSourceIds, random) : activeSourceIds;
  const sourceQuestions = new Map(orderedSourceIds.map((sourceId) => {
    const pool = questions
      .filter((question) => question.sourceId === sourceId)
      .sort((first, second) => first.order - second.order);
    return [sourceId, randomOrder ? shuffled(pool, random) : pool];
  }));

  const combined: T[] = [];
  let sourceIndex = 0;
  let foundQuestion = true;
  while (foundQuestion) {
    foundQuestion = false;
    for (const sourceId of orderedSourceIds) {
      const question = sourceQuestions.get(sourceId)?.[sourceIndex];
      if (question) {
        combined.push(question);
        foundQuestion = true;
      }
    }
    sourceIndex += 1;
  }
  return combined;
}

export function selectExamQuestions<T extends SelectableQuestion>({
  questions,
  sourceIds,
  mode,
  totalCount,
  randomOrder,
  sourceRules,
  random = Math.random,
}: {
  questions: T[];
  sourceIds: string[];
  mode: ExamSelectionMode;
  totalCount: number;
  randomOrder: boolean;
  sourceRules: Record<string, BankSelectionRule>;
  random?: () => number;
}) {
  if (mode === "combined") {
    const ordered = combinedFromSources(questions, sourceIds, randomOrder, random);
    return ordered.slice(0, Math.min(Math.max(0, Math.floor(totalCount)), ordered.length));
  }

  return sourceIds.flatMap((sourceId) => {
    const sourceQuestions = questions.filter((question) => question.sourceId === sourceId);
    const rule = sourceRules[sourceId] ?? { count: 10, randomOrder };
    const ordered = rule.randomOrder
      ? shuffled(sourceQuestions, random)
      : [...sourceQuestions].sort((first, second) => first.order - second.order);
    return ordered.slice(0, Math.min(Math.max(0, Math.floor(rule.count)), ordered.length));
  });
}
