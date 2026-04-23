// The single point in the codebase that touches the Anthropic or Bedrock SDKs.
// Every Claude call site imports `llm` and `resolveModel` from here.
//
// Provider is selected at process start via the LLM_PROVIDER env var.
// Defaults to "anthropic" so landing this file is a pure no-op until the
// Fly.io secret is flipped to "bedrock".
//
// Rollback: `fly secrets set LLM_PROVIDER=anthropic --app robin-copilot` —
// instant, no redeploy.

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

type Provider = "anthropic" | "bedrock";

const PROVIDER: Provider =
  (process.env.LLM_PROVIDER as Provider) || "anthropic";

// Logical model name → provider-specific model ID.
// Bedrock IDs use a `provider.` prefix and a `-v1:0` revision suffix.
// Verify revision suffixes in the Bedrock Console → Model access if a model
// gets a minor revision in the future.
const MODEL_MAP = {
  "sonnet-4": {
    anthropic: "claude-sonnet-4-20250514",
    bedrock: "anthropic.claude-sonnet-4-20250514-v1:0",
  },
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5-20251001",
    bedrock: "anthropic.claude-haiku-4-5-20251001-v1:0",
  },
} as const;

export type ModelName = keyof typeof MODEL_MAP;

/** Translate a logical model name to the active provider's model ID. */
export const resolveModel = (name: ModelName): string =>
  MODEL_MAP[name][PROVIDER];

/**
 * Unified client. Exposes the same `.messages.create` / `.messages.stream`
 * surface regardless of provider — the Bedrock SDK is a drop-in for the
 * direct SDK at the method-signature level.
 *
 * Auth:
 *   - anthropic: reads ANTHROPIC_API_KEY from env automatically
 *   - bedrock:   reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 */
export const llm =
  PROVIDER === "bedrock"
    ? new AnthropicBedrock({
        awsRegion: process.env.AWS_REGION || "us-east-1",
        awsAccessKey: process.env.AWS_ACCESS_KEY_ID!,
        awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY!,
      })
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

/** Exposed for diagnostics / logging. */
export const activeProvider: Provider = PROVIDER;
