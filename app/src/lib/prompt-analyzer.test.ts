import { describe, expect, it } from "vitest";

import { analyzePrompt } from "./prompt-analyzer";

describe("analyzePrompt", () => {
  it("does not nag for prompts that are too short to analyze", () => {
    expect(analyzePrompt("Patch?")).toEqual([]);
  });

  it("suggests the missing operational details for a thin incident prompt", () => {
    const suggestions = analyzePrompt(
      "We saw suspicious activity and need help choosing a response plan.",
    );

    expect(suggestions.map((suggestion) => suggestion.id)).toEqual([
      "timeframe",
      "asset",
      "actor",
      "outcome",
    ]);
  });

  it("stays quiet when prompt includes time, asset, actor, and decision signal", () => {
    const suggestions = analyzePrompt(
      "Yesterday an attacker targeted the production database, and we need to decide containment within 24h.",
    );

    expect(suggestions).toEqual([]);
  });
});
