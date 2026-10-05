/**
 * Client side of extension #31's style profile (src/handlers/style.ts there): the conventions
 * every authoring endpoint applies, stored in the project. The four endpoints are reached
 * through call_endpoint in the `style` group; a project sets its profile once, so none of them
 * earns a place in a tier's listing.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonResult } from "./tool-result.js";

export const GET_STYLE_PROFILE = "get_style_profile";
export const SET_STYLE_PROFILE = "set_style_profile";
export const APPLY_STYLE_PROFILE = "apply_style_profile";
export const EXPLAIN_STYLE_VIOLATION = "explain_style_violation";

type Json = Record<string, unknown>;

/**
 * A /set_style_profile answer as what the next calls depend on: the profile's name, whether it
 * is strict or blocks saving, where it is stored and whether anything changed. The extension
 * answers the whole merged profile, about 600 o200k_base tokens for `uml-standard`, which
 * get_style_profile reads when it is wanted.
 */
export function setProfileResult(data: unknown, input: Json): CallToolResult {
  const profile = (data as { profile?: unknown } | null)?.profile as Json | undefined;
  if (typeof profile !== "object" || profile === null || typeof profile.name !== "string") {
    return jsonResult(data, input);
  }
  const { profile: _whole, ...rest } = data as Json;
  return jsonResult(
    {
      profile: profile.name,
      strict: profile.strict,
      blockSaveOnErrors: profile.blockSaveOnErrors,
      ...rest,
    },
    input,
  );
}
