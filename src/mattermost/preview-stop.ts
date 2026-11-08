import type {
  MattermostValidatedInteraction,
  MattermostInteractionResponse,
} from "./interactions.js";

/** Retired controls must not fall through to a new agent turn on durable replay. */
export function handleMattermostPreviewStop(
  interaction: Pick<MattermostValidatedInteraction, "context">,
): MattermostInteractionResponse | null {
  return "openclaw_preview_stop" in interaction.context
    ? { ephemeral_text: "This Stop button has expired." }
    : null;
}
