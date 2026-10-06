/**
 * Client side of extension #31's style profile (src/handlers/style.ts there): the conventions
 * every authoring endpoint applies, stored in the project. The four endpoints are reached
 * through call_endpoint in the `style` group; a project sets its profile once, so none of them
 * earns a place in a tier's listing.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StarUMLApiError } from "./errors.js";
import { ErrorCode, ToolInputError } from "./errors.js";
import type { StarUMLClient } from "./staruml-client.js";
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

/**
 * Makes the project's style profile strict, or throws PROFILE_NOT_STRICT naming why it is not,
 * before the `oo` tier lets `endpoint` change anything (issue #19). The re-validation found the
 * default `uml-standard` profile is not strict, so the extension's own guard (STYLE_LOCKED for
 * the drawing endpoints, src/style/guard.ts there) never applied to a client that bypasses this
 * server. Only `strict` is patched; `blockSaveOnErrors` stays as the profile has it.
 *
 * The profile is read before every change rather than once per session: it lives in the project,
 * so undo, restore_snapshot, another project or another client can turn it off again, and a read
 * is one local request (about 1 ms against StarUML 7.1.1).
 */
export async function ensureStrictProfile(client: StarUMLClient, endpoint: string): Promise<void> {
  let strict: unknown;
  try {
    strict = await readStrict(client);
    if (strict === true) return;
    await client.callExtension(`/${SET_STYLE_PROFILE}`, { patch: { strict: true } });
    // Read back rather than trusting the answer: what the next request sees is what counts.
    strict = await readStrict(client);
  } catch (error) {
    // callExtension throws nothing but StarUMLApiError.
    const failed = error as StarUMLApiError;
    throw notStrict(endpoint, `${failed.message} [${failed.code}, ${failed.slug}]`);
  }
  if (strict !== true) {
    throw notStrict(endpoint, "the extension still reports strict: false after setting it");
  }
}

async function readStrict(client: StarUMLClient): Promise<unknown> {
  const data = (await client.callExtension(`/${GET_STYLE_PROFILE}`, {})) as {
    profile?: { strict?: unknown };
  } | null;
  return data?.profile?.strict;
}

function notStrict(endpoint: string, why: string): ToolInputError {
  return new ToolInputError(
    `The oo tier makes the project's style profile strict before it changes anything, and could not: ${why}`,
    {
      code: ErrorCode.ProfileNotStrict,
      endpoint,
      hint: "Nothing was changed. Run doctor to check the extension; get_style_profile's problem field names a stored profile StarUML could not read, which has to be fixed in StarUML.",
    },
  );
}
