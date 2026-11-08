import { describe, expect, it } from "vitest";
import { handleMattermostPreviewStop } from "./preview-stop.js";

describe("retired preview Stop callbacks", () => {
  it.each(["previous-runtime-token", "", null, undefined])(
    "consumes a legacy control with token %s without accessing a run",
    (token) => {
      expect(handleMattermostPreviewStop({ context: { openclaw_preview_stop: token } })).toEqual({
        ephemeral_text: "This Stop button has expired.",
      });
    },
  );

  it("leaves unrelated controls to their existing handlers", () => {
    expect(handleMattermostPreviewStop({ context: { callback_data: "models" } })).toBeNull();
  });
});
