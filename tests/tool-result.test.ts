import { describe, expect, it } from "vitest";
import { ErrorCode, StarUMLApiError } from "../src/errors.js";
import { runTool, textResult, toolError } from "../src/tool-result.js";

describe("toolError", () => {
  it("renders a StarUMLApiError with code, endpoint, status and hint", () => {
    const error = new StarUMLApiError("Element not found: e", {
      code: ErrorCode.EndpointNotFound,
      slug: "/get_element_by_id",
      upstream: "extension",
      status: 404,
      hint: "Upgrade the extension.",
    });

    expect(toolError("get element", error)).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Failed to get element: Element not found: e [ENDPOINT_NOT_FOUND, /get_element_by_id, HTTP 404]\nHint: Upgrade the extension.",
        },
      ],
      structuredContent: {
        error: {
          code: "ENDPOINT_NOT_FOUND",
          message: "Element not found: e",
          endpoint: "/get_element_by_id",
          upstream: "extension",
          status: 404,
          hint: "Upgrade the extension.",
        },
      },
    });
  });

  it("omits status and hint when the error has none", () => {
    const error = new StarUMLApiError("down", {
      code: ErrorCode.StarUMLUnreachable,
      slug: "/generate_diagram",
      upstream: "builtin",
    });

    const result = toolError("generate diagram", error);

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Failed to generate diagram: down [STARUML_UNREACHABLE, /generate_diagram]",
      },
    ]);
    expect(result.structuredContent).toEqual({
      error: {
        code: "STARUML_UNREACHABLE",
        message: "down",
        endpoint: "/generate_diagram",
        upstream: "builtin",
      },
    });
  });

  it("classifies a plain Error as UNEXPECTED_ERROR", () => {
    expect(toolError("x", new TypeError("boom"))).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Failed to x: boom [UNEXPECTED_ERROR]" }],
      structuredContent: { error: { code: "UNEXPECTED_ERROR", message: "boom" } },
    });
  });

  it("stringifies non-Error throwables", () => {
    expect(toolError("x", 42).structuredContent).toEqual({
      error: { code: "UNEXPECTED_ERROR", message: "42" },
    });
  });
});

describe("runTool", () => {
  it("returns the body's result", async () => {
    await expect(runTool("x", async () => textResult("ok"))).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("converts a thrown error into an isError result", async () => {
    const result = await runTool("do it", async () => {
      throw new Error("nope");
    });
    expect(result.isError).toBe(true);
  });
});
