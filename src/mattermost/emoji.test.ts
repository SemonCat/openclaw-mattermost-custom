import { describe, expect, it } from "vitest";
import { normalizeMattermostEmojiName } from "./emoji.js";

describe("normalizeMattermostEmojiName", () => {
  it("maps raw Unicode glyphs to Mattermost short names", () => {
    expect(normalizeMattermostEmojiName("👍")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName("✅")).toBe("white_check_mark");
    expect(normalizeMattermostEmojiName("🎉")).toBe("tada");
  });

  it("preserves supported skin tones", () => {
    expect(normalizeMattermostEmojiName("👍🏽")).toBe("thumbsup_medium_skin_tone");
    expect(normalizeMattermostEmojiName("🙌🏿")).toBe("raised_hands_dark_skin_tone");
  });

  it("accepts existing and prototype-shaped short names", () => {
    expect(normalizeMattermostEmojiName(":thumbsup:")).toBe("thumbsup");
    expect(normalizeMattermostEmojiName("constructor")).toBe("constructor");
    expect(normalizeMattermostEmojiName("__proto__")).toBe("__proto__");
  });

  it("returns undefined for blank input", () => {
    expect(normalizeMattermostEmojiName(undefined)).toBeUndefined();
    expect(normalizeMattermostEmojiName("::")).toBeUndefined();
  });
});
