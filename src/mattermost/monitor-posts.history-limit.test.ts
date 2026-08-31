import { describe, expect, it } from "vitest";
import { resolveMattermostHistoryLimit } from "./monitor-posts.js";

describe("resolveMattermostHistoryLimit", () => {
  it.each([
    {
      params: { accountHistoryLimit: 3, globalHistoryLimit: 7 },
      expected: 3,
    },
    {
      params: { globalHistoryLimit: 7 },
      expected: 7,
    },
    {
      params: { accountHistoryLimit: 0, globalHistoryLimit: 7 },
      expected: 0,
    },
  ])("resolves the effective $expected limit", ({ params, expected }) => {
    expect(resolveMattermostHistoryLimit(params)).toBe(expected);
  });
});
