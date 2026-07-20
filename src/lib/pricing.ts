type Rate = { inputPerMillion: number; outputPerMillion: number };

const RATES: Array<[RegExp, Rate]> = [
  [/claude-sonnet-4/i, { inputPerMillion: 3, outputPerMillion: 15 }],
  [/claude-opus-4/i, { inputPerMillion: 15, outputPerMillion: 75 }],
  [/claude-3-5-haiku/i, { inputPerMillion: 0.8, outputPerMillion: 4 }],
];

export function estimateClaudeCostUsd(model: string, inputTokens: number, outputTokens: number) {
  const rate = RATES.find(([pattern]) => pattern.test(model))?.[1];
  if (!rate) return 0;
  return Number(((inputTokens / 1_000_000) * rate.inputPerMillion + (outputTokens / 1_000_000) * rate.outputPerMillion).toFixed(6));
}
