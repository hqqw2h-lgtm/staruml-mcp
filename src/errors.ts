export const EXTENSION_REPOSITORY = "https://github.com/hqqw2h-lgtm/staruml-mcp-extension";

/**
 * Codes produced by this client. A `code` field in an upstream error body is passed through
 * verbatim instead, so callers can see codes the extension defines without this list knowing them.
 */
export const ErrorCode = {
  StarUMLUnreachable: "STARUML_UNREACHABLE",
  ExtensionUnreachable: "EXTENSION_UNREACHABLE",
  EndpointNotFound: "ENDPOINT_NOT_FOUND",
  RequestRejected: "REQUEST_REJECTED",
  UpstreamError: "UPSTREAM_ERROR",
  InvalidResponse: "INVALID_RESPONSE",
  Unexpected: "UNEXPECTED_ERROR",
  // The next two are extension 0.3.0 codes (src/errors.ts there), reused for the same faults
  // when this server catches them first, so a caller handles both sources alike.
  UnknownEndpoint: "UNKNOWN_ENDPOINT",
  InvalidArgument: "INVALID_ARGUMENT",
  /** generate_diagram was asked for what only the extension's build_diagram does. */
  ExtensionRequired: "EXTENSION_REQUIRED",
} as const;

export type Upstream = "builtin" | "extension";

export interface StarUMLApiErrorOptions {
  code: string;
  slug: string;
  upstream: Upstream;
  status?: number;
  hint?: string;
  /** The `details` of the extension's error body, such as an atomic batch's `{index, results}`. */
  details?: unknown;
  cause?: unknown;
}

/** Serialized form returned to MCP clients as `structuredContent.error`. */
export interface ErrorDetail {
  code: string;
  message: string;
  endpoint?: string;
  upstream?: Upstream;
  status?: number;
  hint?: string;
  details?: unknown;
}

export class StarUMLApiError extends Error {
  readonly code: string;
  readonly slug: string;
  readonly upstream: Upstream;
  readonly status: number | undefined;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(message: string, options: StarUMLApiErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "StarUMLApiError";
    this.code = options.code;
    this.slug = options.slug;
    this.upstream = options.upstream;
    this.status = options.status;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): ErrorDetail {
    return {
      code: this.code,
      message: this.message,
      endpoint: this.slug,
      upstream: this.upstream,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/**
 * A call this server refuses before sending anything: an endpoint the manifest does not have, or
 * a body its schema rejects.
 */
export class ToolInputError extends Error {
  readonly code: string;
  readonly endpoint: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: { code: string; endpoint?: string; hint?: string }) {
    super(message);
    this.name = "ToolInputError";
    this.code = options.code;
    this.endpoint = options.endpoint;
    this.hint = options.hint;
  }

  toJSON(): ErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.endpoint === undefined ? {} : { endpoint: this.endpoint }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}
