import type { ResolvedChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
// Mattermost type declarations define plugin contracts.
import type { ChannelPreviewStreamingConfig } from "openclaw/plugin-sdk/channel-outbound";
import type { ContextVisibilityMode, DmPolicy, GroupPolicy } from "./runtime-api.js";
import type { SecretInput } from "./secret-input.js";

export type MattermostReplyToMode = "off" | "first" | "all" | "batched";
export type MattermostChatTypeKey = "direct" | "channel" | "group";

export type MattermostChatMode = "oncall" | "onmessage" | "onchar";
export type MattermostExecApprovalConfig = {
  /** Enable native approval cards. Auto enables when stable approver ids are configured. */
  enabled?: boolean | "auto";
  /** Stable Mattermost user ids allowed to decide approval requests. */
  approvers?: Array<string | number>;
  agentFilter?: string[];
  sessionFilter?: string[];
  /** Origin thread, approver DMs, or both. Mattermost defaults to the origin channel. */
  target?: "dm" | "channel" | "both";
};
type MattermostNetworkConfig = {
  /** Dangerous opt-in for self-hosted Mattermost on trusted private/internal hosts. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type MattermostAccountConfig = {
  /** Megabyte cap for media this channel accepts and delivers. */
  mediaMaxMb?: number;
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /**
   * Break-glass override: allow mutable identity matching (@username/display name) in allowlists.
   * Default behavior is ID-only matching.
   */
  dangerouslyAllowNameMatching?: boolean;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** Supplemental context visibility policy for inbound context (default: all). */
  contextVisibility?: ContextVisibilityMode;
  /** If false, do not start this Mattermost account. Default: true. */
  enabled?: boolean;
  /** Bot token for Mattermost. */
  botToken?: SecretInput;
  /** Base URL for the Mattermost server (e.g., https://chat.example.com). */
  baseUrl?: string;
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: MattermostChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Implicit mention policy for replies, quotes, and participated threads. */
  implicitMentions?: Partial<ResolvedChannelImplicitMentions>;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user ids or @usernames). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user ids or @usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Maximum pending group messages included as supplemental history. */
  historyLimit?: number;
  /** Preview streaming config (nested-only; scalar modes migrate via doctor). */
  streaming?: ChannelPreviewStreamingConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /**
   * Controls whether channel and group replies are sent as thread replies when
   * `replyToModeByChatType` does not override that chat type.
   * - "off" (default): only thread-reply when incoming message is already a thread reply
   * - "first": reply in a thread under the triggering message
   * - "all": always reply in a thread; uses existing thread root or starts a new thread under the message
   * Direct messages default to "off" unless explicitly overridden.
   */
  replyToMode?: MattermostReplyToMode;
  /**
   * Per-chat-type reply threading overrides. Set `direct` to opt DMs into
   * independent thread-scoped sessions; when omitted, DMs stay flat.
   */
  replyToModeByChatType?: Partial<Record<MattermostChatTypeKey, MattermostReplyToMode>>;
  /** Action toggles for this account. */
  actions?: {
    /** Enable channel message reads. Default: false. */
    messages?: boolean;
    /** Enable message reaction actions. Default: true. */
    reactions?: boolean;
    /** Enable editing posts through the message tool. Default: true. */
    edit?: boolean;
    /** Enable deleting posts through the message tool. Default: true. */
    delete?: boolean;
    /** Enable pin, unpin, and pinned-post reads. Default: true. */
    pins?: boolean;
  };
  /** Channel IDs allowed for delegated cross-channel reads and inbound routing. */
  groups?: Record<string, { requireMention?: boolean } | undefined>;
  /** Bounded same-instance permalink expansion before model dispatch. */
  permalinkHydration?: {
    /** Enabled by default. */
    enabled?: boolean;
    /** Maximum links expanded from one inbound post (default 3, max 5). */
    maxLinks?: number;
    /** Maximum posts read from each thread (default 50, max 100). */
    maxPosts?: number;
    /** Maximum combined prompt characters (default 20000, max 60000). */
    maxChars?: number;
    /** Public reverse-proxy origins accepted as aliases for this Mattermost instance. */
    allowedOrigins?: string[];
  };
  /** Native slash command configuration. */
  commands?: {
    /** Enable native slash commands. "auto" resolves to false (opt-in). */
    native?: boolean | "auto";
    /** Also register skill-based commands. */
    nativeSkills?: boolean | "auto";
    /** Path for the callback endpoint on the gateway HTTP server. */
    callbackPath?: string;
    /** Explicit callback URL (e.g. behind reverse proxy). */
    callbackUrl?: string;
  };
  interactions?: {
    /** External base URL used for Mattermost interaction callbacks. */
    callbackBaseUrl?: string;
    /**
     * IP/CIDR allowlist for callback request sources when Mattermost reaches the gateway
     * over a non-loopback path. Keep this narrow to the Mattermost server or trusted ingress.
     */
    allowedSourceIps?: string[];
    /** Prefer native Mattermost Blocks for interactive buttons. Default: true. */
    blocks?: boolean;
  };
  /** Native exec/plugin/system-agent approval cards and routing. */
  execApprovals?: MattermostExecApprovalConfig;
  /** Network policy overrides for self-hosted Mattermost on trusted private/internal hosts. */
  network?: MattermostNetworkConfig;
  /** Retry configuration for DM channel creation */
  dmChannelRetry?: {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial delay in milliseconds before first retry (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay in milliseconds between retries (default: 10000) */
    maxDelayMs?: number;
    /** Timeout for each individual request in milliseconds (default: 30000) */
    timeoutMs?: number;
  };
};

export type MattermostConfig = {
  /** Optional per-account Mattermost configuration (multi-account). */
  accounts?: Record<string, MattermostAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & MattermostAccountConfig;
