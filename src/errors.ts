export const EXTENSION_REPOSITORY = "https://github.com/ezrabrilliant/staruml-mcp-extension";

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
} as const;

export type Upstream = "builtin" | "extension";

export interface StarUMLApiErrorOptions {
  code: string;
  slug: string;
  upstream: Upstream;
  status?: number;
  hint?: string;
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
}

export class StarUMLApiError extends Error {
  readonly code: string;
  readonly slug: string;
  readonly upstream: Upstream;
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: StarUMLApiErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "StarUMLApiError";
    this.code = options.code;
    this.slug = options.slug;
    this.upstream = options.upstream;
    this.status = options.status;
    this.hint = options.hint;
  }

  toJSON(): ErrorDetail {
    return {
      code: this.code,
      message: this.message,
      endpoint: this.slug,
      upstream: this.upstream,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }
}
