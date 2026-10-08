import { describe, expect, it } from "vitest";
import { UI_PROTOCOL_VERSION, VIEWER_HTML } from "../src/viewer.js";
import { loadViewer, type LoadedViewer } from "./support/viewer.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><text>Book</text></svg>';
const RESULT = {
  content: [{ type: "text", text: '{"diagram":"D1"}' }],
  structuredContent: { diagram: "D1", name: "Main", width: 400, height: 200, svg: SVG },
};

const notification = (method: string, params: unknown) => ({ jsonrpc: "2.0", method, params });

/** A viewer that completed `ui/initialize` with `hostContext`. */
async function initialized(hostContext: Record<string, unknown> = {}): Promise<LoadedViewer> {
  const viewer = loadViewer(VIEWER_HTML);
  viewer.receive({ jsonrpc: "2.0", id: 1, result: { hostContext } });
  await viewer.settle();
  viewer.posted.length = 0;
  return viewer;
}

describe("viewer handshake", () => {
  it("opens with ui/initialize and confirms with ui/notifications/initialized", async () => {
    const viewer = loadViewer(VIEWER_HTML);

    expect(viewer.posted).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: {
          appInfo: { name: "staruml-viewer", version: "1" },
          appCapabilities: {},
          protocolVersion: UI_PROTOCOL_VERSION,
        },
      },
    ]);

    viewer.receive({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } });
    await viewer.settle();

    expect(viewer.posted[1]).toEqual(notification("ui/notifications/initialized", {}));
    expect(viewer.root.getAttribute("data-theme")).toBe("dark");
    expect(viewer.elements.dark.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the page theme when the host sends no context", async () => {
    const viewer = loadViewer(VIEWER_HTML);
    viewer.receive({ jsonrpc: "2.0", id: 1 });
    await viewer.settle();

    expect(viewer.root.getAttribute("data-theme")).toBeNull();
    expect(viewer.posted[1]).toEqual(notification("ui/notifications/initialized", {}));
  });

  it("ignores messages from other frames and anything that is not JSON-RPC 2.0", async () => {
    const viewer = await initialized();

    viewer.receive(notification("ui/notifications/tool-result", RESULT), {});
    viewer.receive(null);
    viewer.receive({ method: "ui/notifications/tool-result", params: RESULT });
    viewer.receive({ jsonrpc: "2.0", id: 99, result: {} });

    expect(viewer.elements.diagram.src).toBe("");
    expect(viewer.posted).toEqual([]);
  });

  it("answers ping and teardown, and refuses other requests", async () => {
    const viewer = await initialized();

    viewer.receive({ jsonrpc: "2.0", id: 7, method: "ping" });
    viewer.receive({ jsonrpc: "2.0", id: 8, method: "ui/resource-teardown", params: {} });
    viewer.receive({ jsonrpc: "2.0", id: 9, method: "tools/call", params: {} });

    expect(viewer.posted).toEqual([
      { jsonrpc: "2.0", id: 7, result: {} },
      { jsonrpc: "2.0", id: 8, result: {} },
      { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found" } },
    ]);
  });
});

describe("viewer rendering", () => {
  it("shows the tool result's SVG as an image with the diagram's name", async () => {
    const viewer = await initialized();

    viewer.receive(notification("ui/notifications/tool-result", RESULT));

    const { diagram, name, status } = viewer.elements;
    expect(diagram.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`);
    expect(diagram.alt).toBe("Main");
    expect(diagram.style).toMatchObject({ width: "400px", height: "200px" });
    expect(name.textContent).toBe("Main");
    expect(status.textContent).toBe("");
    // Fitted into the 800×400 stage: scale 2 (capped), centred.
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");
    expect(viewer.posted).toEqual([notification("ui/notifications/size-changed", { height: 284 })]);
  });

  it("names an unnamed diagram and caps the requested height", async () => {
    const viewer = await initialized();
    const tall = { ...RESULT.structuredContent, name: "", height: 2000 };

    viewer.receive(notification("ui/notifications/tool-result", { structuredContent: tall }));

    expect(viewer.elements.name.textContent).toBe("Diagram");
    expect(viewer.elements.diagram.alt).toBe("Diagram");
    expect(viewer.posted).toEqual([notification("ui/notifications/size-changed", { height: 684 })]);
  });

  it("shows the text of a result without an SVG, such as a tool error", async () => {
    const viewer = await initialized();

    viewer.receive(
      notification("ui/notifications/tool-result", {
        isError: true,
        content: [{ type: "text", text: "Failed to view diagram: down" }],
      }),
    );
    expect(viewer.elements.status.textContent).toBe("Failed to view diagram: down");

    viewer.receive(notification("ui/notifications/tool-result", { content: [] }));
    expect(viewer.elements.status.textContent).toBe("No diagram in this result.");

    viewer.receive(notification("ui/notifications/tool-result", undefined));
    expect(viewer.elements.status.textContent).toBe("No diagram in this result.");
    expect(viewer.elements.diagram.src).toBe("");
  });

  it("follows the host theme until the user picks one", async () => {
    const viewer = await initialized();
    const changed = (theme?: string) =>
      viewer.receive(notification("ui/notifications/host-context-changed", { theme }));

    changed("dark");
    expect(viewer.root.getAttribute("data-theme")).toBe("dark");
    changed();
    expect(viewer.root.getAttribute("data-theme")).toBe("dark");

    viewer.elements.dark.dispatch("click");
    expect(viewer.root.getAttribute("data-theme")).toBe("light");
    expect(viewer.elements.dark.getAttribute("aria-pressed")).toBe("false");
    changed("dark");
    expect(viewer.root.getAttribute("data-theme")).toBe("light");
    viewer.elements.dark.dispatch("click");
    expect(viewer.root.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a host theme that arrives after the user picked one at start", async () => {
    const viewer = loadViewer(VIEWER_HTML);
    viewer.elements.dark.dispatch("click");
    viewer.receive({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "light" } } });
    await viewer.settle();

    expect(viewer.root.getAttribute("data-theme")).toBe("dark");
  });
});

describe("viewer pan and zoom", () => {
  async function shown(): Promise<LoadedViewer> {
    const viewer = await initialized();
    viewer.receive(notification("ui/notifications/tool-result", RESULT));
    return viewer;
  }

  it("zooms with the buttons around the stage centre and fits again", async () => {
    const viewer = await shown();
    const { diagram } = viewer.elements;

    viewer.elements["zoom-out"].dispatch("click");
    expect(diagram.style.transform).toBe("translate(80px, 40px) scale(1.6)");
    viewer.elements["zoom-in"].dispatch("click");
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");

    viewer.elements.stage.dispatch("dblclick");
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");
    viewer.elements.fit.dispatch("click");
    viewer.window.dispatch("resize");
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");
  });

  it("zooms with the wheel around the pointer, within limits", async () => {
    const viewer = await shown();
    const { diagram, stage } = viewer.elements;
    let prevented = 0;
    const wheel = (deltaY: number) =>
      stage.dispatch("wheel", {
        deltaY,
        offsetX: 0,
        offsetY: 0,
        preventDefault: () => prevented++,
      });

    wheel(-1);
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2.2)");
    wheel(1);
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");
    for (let i = 0; i < 60; i++) wheel(-1);
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(20)");
    for (let i = 0; i < 120; i++) wheel(1);
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(0.05)");
    expect(prevented).toBe(182);
  });

  it("pans while the pointer is down", async () => {
    const viewer = await shown();
    const { diagram, stage } = viewer.elements;

    stage.dispatch("pointermove", { clientX: 50, clientY: 50 });
    expect(diagram.style.transform).toBe("translate(0px, 0px) scale(2)");
    stage.dispatch("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 });
    stage.dispatch("pointermove", { clientX: 40, clientY: 25 });
    expect(diagram.style.transform).toBe("translate(30px, 15px) scale(2)");
    stage.dispatch("pointerup");
    stage.dispatch("pointermove", { clientX: 90, clientY: 90 });
    expect(diagram.style.transform).toBe("translate(30px, 15px) scale(2)");
  });

  it("does nothing on fit before a diagram arrives or on an empty stage", async () => {
    const viewer = await initialized();
    viewer.elements.fit.dispatch("click");
    expect(viewer.elements.diagram.style.transform).toBeUndefined();

    viewer.elements.stage.clientWidth = 0;
    viewer.receive(notification("ui/notifications/tool-result", RESULT));
    expect(viewer.elements.diagram.style.transform).toBe("translate(-200px, 100px) scale(1)");
  });
});
