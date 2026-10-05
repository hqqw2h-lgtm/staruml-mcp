import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { diagramImageUri } from "../src/server.js";
import { closedPort, UpstreamFixture } from "./support/fixture.js";
import { connect, type ConnectedClient } from "./support/mcp.js";

const HOST = "http://127.0.0.1";
// Real 7.1.1 ids are base64-like and can contain `/` and `=`.
const DIAGRAM_ID = "AAAAAAGhCh/2wd1CFIY=";
const DIAGRAMS = [
  { id: DIAGRAM_ID, type: "UMLClassDiagram", name: "Main", description: "" },
  { id: "D2", type: "UMLSequenceDiagram", name: "Flow", description: "" },
];

const builtin = new UpstreamFixture();
const extension = new UpstreamFixture();
let mcp: ConnectedClient;

beforeAll(async () => {
  await Promise.all([builtin.start(), extension.start()]);
  mcp = await connect({ apiHost: HOST, apiPort: builtin.port, extPort: extension.port });
});

afterEach(() => {
  builtin.reset();
  extension.reset();
});

afterAll(async () => {
  await mcp.close();
  await Promise.all([builtin.stop(), extension.stop()]);
});

async function readError(uri: string): Promise<McpError> {
  const error: unknown = await mcp.client.readResource({ uri }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe("diagramImageUri", () => {
  it("percent-encodes characters an id may contain", () => {
    expect(diagramImageUri("a/b+c=")).toBe("staruml://diagram/a%2Fb%2Bc%3D.png");
  });
});

describe("resources/list", () => {
  it("lists the static resources and one PNG per diagram", async () => {
    builtin.reply("/get_all_diagrams_info", { body: { success: true, data: DIAGRAMS } });

    const { resources } = await mcp.client.listResources();

    expect(resources).toEqual([
      expect.objectContaining({
        uri: "staruml://diagrams",
        name: "diagrams",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://project",
        name: "project",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "staruml://diagram/AAAAAAGhCh%2F2wd1CFIY%3D.png",
        name: "Main",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        uri: "staruml://diagram/D2.png",
        name: "Flow",
        mimeType: "image/png",
      }),
    ]);
  });

  it("still lists the static resources when StarUML is unreachable", async () => {
    const down = await connect({ apiHost: HOST, apiPort: await closedPort() });
    try {
      const { resources } = await down.client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(["staruml://diagrams", "staruml://project"]);
    } finally {
      await down.close();
    }
  });

  it("publishes the diagram image template", async () => {
    const { resourceTemplates } = await mcp.client.listResourceTemplates();

    expect(resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "staruml://diagram/{id}.png",
        name: "diagram-image",
        mimeType: "image/png",
      }),
    ]);
  });
});

describe("staruml://diagrams", () => {
  it("returns compact JSON", async () => {
    builtin.reply("/get_all_diagrams_info", { body: { success: true, data: DIAGRAMS } });

    const { contents } = await mcp.client.readResource({ uri: "staruml://diagrams" });

    expect(contents).toEqual([
      {
        uri: "staruml://diagrams",
        mimeType: "application/json",
        text: JSON.stringify(DIAGRAMS),
      },
    ]);
  });

  it("fails with the structured StarUML error", async () => {
    builtin.reply("/get_all_diagrams_info", {
      status: 500,
      body: { success: false, error: "boom" },
    });

    const error = await readError("staruml://diagrams");

    expect(error.message).toContain(
      "Failed to read diagrams: boom [UPSTREAM_ERROR, /get_all_diagrams_info, HTTP 500]",
    );
    expect(error.data).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "boom",
        endpoint: "/get_all_diagrams_info",
        upstream: "builtin",
        status: 500,
      },
    });
  });
});

describe("staruml://project", () => {
  it("returns the extension's project info without null fields", async () => {
    extension.reply("/get_project_info", {
      body: {
        success: true,
        data: { filename: null, project: { _id: "P1", name: "Untitled", ownedElementsCount: 0 } },
      },
    });

    const { contents } = await mcp.client.readResource({ uri: "staruml://project" });

    expect(contents).toEqual([
      {
        uri: "staruml://project",
        mimeType: "application/json",
        text: '{"project":{"_id":"P1","name":"Untitled","ownedElementsCount":0}}',
      },
    ]);
  });

  it("fails with EXTENSION_UNREACHABLE when the extension is missing", async () => {
    const noExt = await connect({
      apiHost: HOST,
      apiPort: builtin.port,
      extPort: await closedPort(),
    });
    try {
      const error: unknown = await noExt.client
        .readResource({ uri: "staruml://project" })
        .catch((e: unknown) => e);
      expect((error as McpError).data).toMatchObject({
        error: { code: "EXTENSION_UNREACHABLE", endpoint: "/get_project_info" },
      });
    } finally {
      await noExt.close();
    }
  });
});

describe("staruml://diagram/{id}.png", () => {
  it("returns the PNG as a blob for a percent-encoded id", async () => {
    builtin.reply("/get_diagram_image_by_id", { body: { success: true, data: "iVBORw0KGgo=" } });
    const uri = diagramImageUri(DIAGRAM_ID);

    const { contents } = await mcp.client.readResource({ uri });

    expect(contents).toEqual([{ uri, mimeType: "image/png", blob: "iVBORw0KGgo=" }]);
    expect(builtin.requests).toEqual([
      { method: "POST", path: "/get_diagram_image_by_id", body: { diagramId: DIAGRAM_ID } },
    ]);
  });

  it("fails with StarUML's error for an unknown diagram", async () => {
    builtin.reply("/get_diagram_image_by_id", {
      status: 500,
      body: { success: false, error: "Diagram not found" },
    });

    const error = await readError("staruml://diagram/nope.png");

    expect(error.data).toMatchObject({
      error: { code: "UPSTREAM_ERROR", message: "Diagram not found" },
    });
  });

  it("rejects a malformed percent-encoding without calling StarUML", async () => {
    const error = await readError("staruml://diagram/%E0%A4%A.png");

    expect(error.data).toMatchObject({ error: { code: "UNEXPECTED_ERROR" } });
    expect(builtin.requests).toEqual([]);
  });
});
