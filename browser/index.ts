import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";

export default defineControlUiPlugin({
  id: "mattermost-custom",
  activate() {
    // 10.5 retires conversationLink from both session storage and Gateway rows.
    // Keep the declared browser entry inert until a supported origin source exists.
  },
});
