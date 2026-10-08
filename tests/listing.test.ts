/**
 * The hand-written part of the listing as a client sees it. Descriptions and annotations are what
 * the model reads to choose a tool or resource, so a change to any of them shows up here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECTION_INSTRUCTIONS } from "../src/manifest.js";
import { closedPort } from "./support/fixture.js";
import { connect, type ConnectedClient } from "./support/mcp.js";

let mcp: ConnectedClient;

beforeAll(async () => {
  const refused = await closedPort();
  mcp = await connect({ apiPort: refused, extPort: refused });
});

afterAll(async () => {
  await mcp.close();
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const JSON_TYPE = "application/json";

describe("listing", () => {
  it("states the result conventions once, in the instructions", () => {
    expect(mcp.client.getInstructions()).toBe(
      "Results are JSON without null or empty fields or echoed arguments. " +
        `${PROJECTION_INSTRUCTIONS} ` +
        "Element fields take an _id or a path: Pkg/Class, Class.attr, Class#op(), Class@Diagram, " +
        "@current. " +
        "Endpoints without a tool: describe_endpoints, then call_endpoint. " +
        "Resources: diagram PNG, Mermaid, PlantUML; project tree; metamodel; endpoints; patterns.",
    );
  });

  it("describes and annotates the hand-written tools", async () => {
    const hand = new Set([
      "generate_diagram",
      "get_all_diagrams_info",
      "get_current_diagram_info",
      "get_diagram_image_by_id",
      "view_diagram",
      "diagram_as_text",
      "doctor",
    ]);
    const { tools } = await mcp.client.listTools();

    expect(
      tools
        .filter((t) => hand.has(t.name))
        .map(({ name, description, annotations }) => ({ name, description, annotations })),
    ).toEqual([
      {
        name: "generate_diagram",
        description: "Render Mermaid code as a new StarUML diagram.",
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_all_diagrams_info",
        description: "List diagrams (id, type, name) of the open project.",
        annotations: READ_ONLY,
      },
      {
        name: "get_current_diagram_info",
        description: "Active diagram (id, type, name), or null.",
        annotations: READ_ONLY,
      },
      { name: "get_diagram_image_by_id", description: "Diagram as PNG.", annotations: READ_ONLY },
      {
        name: "view_diagram",
        description: "Show a diagram: SVG viewer under MCP Apps, else PNG.",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "diagram_as_text",
        description:
          "A diagram as Mermaid (default), PlantUML or spec text; build_diagram reads each back.",
        annotations: READ_ONLY,
      },
      {
        name: "doctor",
        description: "Check StarUML, extension and Node setup; reloads the extension's tools.",
        annotations: READ_ONLY,
      },
    ]);
  });

  it("describes the resources and templates with their media types", async () => {
    const { resources } = await mcp.client.listResources();
    const { resourceTemplates } = await mcp.client.listResourceTemplates();

    expect(
      resources.map(({ uri, description, mimeType }) => ({ uri, description, mimeType })),
    ).toEqual([
      {
        uri: "staruml://diagrams",
        description: "Diagrams (id, type, name) of the open project.",
        mimeType: JSON_TYPE,
      },
      {
        uri: "staruml://project",
        description: "Project filename and root summary.",
        mimeType: JSON_TYPE,
      },
      {
        uri: "staruml://project/tree",
        description:
          "Model elements and diagrams as an ownership tree (_id, _type, name, children).",
        mimeType: JSON_TYPE,
      },
      {
        uri: "staruml://introspect/metamodel",
        description: "Every metamodel type with its attributes, supertypes and view types.",
        mimeType: JSON_TYPE,
      },
      {
        uri: "staruml://introspect/endpoints",
        description: "The extension's endpoint manifest with request and response JSON Schemas.",
        mimeType: JSON_TYPE,
      },
      {
        uri: "staruml://patterns",
        description: "Design patterns apply_pattern applies: category, intent, roles, variants.",
        mimeType: JSON_TYPE,
      },
      {
        uri: "ui://staruml/viewer.html",
        description: "Interactive SVG viewer for view_diagram (MCP Apps).",
        mimeType: "text/html;profile=mcp-app",
      },
    ]);
    expect(
      resourceTemplates.map(({ uriTemplate, description, mimeType }) => ({
        uriTemplate,
        description,
        mimeType,
      })),
    ).toEqual([
      {
        uriTemplate: "staruml://pattern/{name}",
        description:
          "A pattern's roles, members, relationship ends and the properties each gets; what apply_pattern sets.",
        mimeType: JSON_TYPE,
      },
      {
        uriTemplate: "staruml://diagram/{id}.png",
        description: "Diagram rendered as PNG.",
        mimeType: "image/png",
      },
      {
        uriTemplate: "staruml://diagram/{id}.mmd",
        description: "Diagram written as Mermaid text.",
        mimeType: "text/plain",
      },
      {
        uriTemplate: "staruml://diagram/{id}.puml",
        description: "Diagram written as PlantUML text.",
        mimeType: "text/plain",
      },
    ]);
  });
});
