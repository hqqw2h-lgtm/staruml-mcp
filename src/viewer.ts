/**
 * The inline diagram viewer: an MCP Apps view (`ui://` resource) that a host renders in a
 * sandboxed iframe next to the view_diagram result.
 *
 * Targets MCP Apps protocol 2026-01-26 as published in @modelcontextprotocol/ext-apps 1.7.4. That
 * package is not a dependency: the MCP TypeScript SDK this server uses (1.29.0) has no UI
 * helpers, but it does pass `capabilities.extensions` and tool `_meta` through, which is all the
 * server side needs. The view speaks the protocol's JSON-RPC over `postMessage` itself, so the
 * page stays one self-contained file with no bundler step.
 */

/** ext-apps `EXTENSION_ID`: the client capability key under `capabilities.extensions`. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** ext-apps `RESOURCE_MIME_TYPE`. */
export const VIEWER_MIME_TYPE = "text/html;profile=mcp-app";
export const VIEWER_URI = "ui://staruml/viewer.html";
/** ext-apps `LATEST_PROTOCOL_VERSION`, sent by the view in `ui/initialize`. */
export const UI_PROTOCOL_VERSION = "2026-01-26";

/**
 * Tool `_meta` naming the view. ext-apps' `registerAppTool` writes both keys: `ui.resourceUri` is
 * the current form and the flat `ui/resourceUri` the one hosts released before 1.0 read.
 */
export const VIEWER_TOOL_META = { ui: { resourceUri: VIEWER_URI }, "ui/resourceUri": VIEWER_URI };

/** Whether `initialize` capabilities say the client renders MCP Apps HTML (ext-apps `getUiCapability`). */
export function declaresUi(capabilities: unknown): boolean {
  const extensions = (capabilities as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
  const mimeTypes = (extensions?.[UI_EXTENSION] as { mimeTypes?: unknown } | undefined)?.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(VIEWER_MIME_TYPE);
}

/** What view_diagram hands the view in `structuredContent`. */
export interface ViewerData {
  diagram: string;
  name: string;
  svg: string;
  width: number;
  height: number;
}

/**
 * The view's script. The SVG is shown through an `<img>` data URL rather than inlined: an image
 * never runs scripts or loads anything, whatever text a model element's name put into the SVG,
 * and `img-src data:` is in the CSP hosts apply when a resource declares no domains (ext-apps
 * `McpUiResourceCsp`).
 */
export const VIEWER_SCRIPT = String.raw`(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const img = $("diagram");
  const title = $("name");
  const status = $("status");
  const dark = $("dark");
  const view = { scale: 1, x: 0, y: 0 };
  let size = { width: 0, height: 0 };
  let themeChosen = false;
  let nextId = 1;
  const pending = new Map();

  const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const notify = (method, params) => send({ method, params });
  const request = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve) => pending.set(id, resolve));
  };

  const apply = () => {
    img.style.transform = "translate(" + view.x + "px, " + view.y + "px) scale(" + view.scale + ")";
  };
  const fit = () => {
    if (!size.width || !size.height) return;
    const scale = Math.min(stage.clientWidth / size.width, stage.clientHeight / size.height, 2);
    view.scale = scale > 0 ? scale : 1;
    view.x = (stage.clientWidth - size.width * view.scale) / 2;
    view.y = (stage.clientHeight - size.height * view.scale) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const scale = Math.min(Math.max(view.scale * factor, 0.05), 20);
    view.x = cx - ((cx - view.x) * scale) / view.scale;
    view.y = cy - ((cy - view.y) * scale) / view.scale;
    view.scale = scale;
    apply();
  };
  const setTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    dark.setAttribute("aria-pressed", String(theme === "dark"));
  };

  const show = (result) => {
    const data = result && result.structuredContent;
    if (!data || typeof data.svg !== "string") {
      const text = ((result && result.content) || []).find((c) => c.type === "text");
      status.textContent = text ? text.text : "No diagram in this result.";
      return;
    }
    title.textContent = data.name || "Diagram";
    size = { width: data.width, height: data.height };
    img.style.width = size.width + "px";
    img.style.height = size.height + "px";
    img.alt = data.name || "Diagram";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.svg);
    status.textContent = "";
    fit();
    notify("ui/notifications/size-changed", {
      height: Math.round(Math.min(Math.max(size.height, 240), 640)) + 44,
    });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      if (resolve) resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      if (message.method === "ping" || message.method === "ui/resource-teardown") {
        send({ id: message.id, result: {} });
      } else {
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    if (message.method === "ui/notifications/tool-result") show(message.params);
    const theme = message.params && message.params.theme;
    if (message.method === "ui/notifications/host-context-changed" && theme && !themeChosen) {
      setTheme(theme);
    }
  });

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.offsetX, event.offsetY);
  });
  let drag = null;
  stage.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX - view.x, y: event.clientY - view.y };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
    view.x = event.clientX - drag.x;
    view.y = event.clientY - drag.y;
    apply();
  });
  stage.addEventListener("pointerup", () => {
    drag = null;
  });
  stage.addEventListener("dblclick", fit);
  const centre = () => [stage.clientWidth / 2, stage.clientHeight / 2];
  $("fit").addEventListener("click", fit);
  $("zoom-in").addEventListener("click", () => zoomAt(1.25, ...centre()));
  $("zoom-out").addEventListener("click", () => zoomAt(1 / 1.25, ...centre()));
  dark.addEventListener("click", () => {
    themeChosen = true;
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  window.addEventListener("resize", fit);

  request("ui/initialize", {
    appInfo: { name: "staruml-viewer", version: "1" },
    appCapabilities: {},
    protocolVersion: "${UI_PROTOCOL_VERSION}",
  }).then((result) => {
    const theme = result && result.hostContext && result.hostContext.theme;
    if (theme && !themeChosen) setTheme(theme);
    notify("ui/notifications/initialized", {});
  });
})();`;

/**
 * Dark mode inverts the rendering: StarUML draws black on white fills and the SVG carries no
 * theme of its own, so `invert` with a half turn of hue keeps colour fills recognisable.
 */
const STYLE = `
:root { color-scheme: light; --bg: #ffffff; --fg: #1f2328; --bar: #f6f8fa; --line: #d0d7de; }
:root[data-theme="dark"] { color-scheme: dark; --bg: #1e1e1e; --fg: #e6edf3; --bar: #2d2d2d; --line: #444c56; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px system-ui, sans-serif; }
body { display: flex; flex-direction: column; min-height: 284px; }
header { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 10px; background: var(--bar); border-bottom: 1px solid var(--line); }
#name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { min-width: 32px; height: 28px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
button[aria-pressed="true"] { background: var(--line); }
#stage { position: relative; flex: 1; overflow: hidden; cursor: grab; touch-action: none; }
#stage:active { cursor: grabbing; }
#diagram { position: absolute; left: 0; top: 0; transform-origin: 0 0; user-select: none; -webkit-user-drag: none; }
:root[data-theme="dark"] #diagram { filter: invert(1) hue-rotate(180deg); }
#status { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; }
#status:empty { display: none; }
`;

export const VIEWER_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StarUML diagram</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<span id="name">StarUML diagram</span>
<button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">&minus;</button>
<button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
<button id="fit" type="button" title="Fit to view (double-click)">Fit</button>
<button id="dark" type="button" title="Dark mode" aria-pressed="false">Dark</button>
</header>
<main id="stage">
<img id="diagram" alt="" draggable="false">
<div id="status">Waiting for the diagram&hellip;</div>
</main>
<script>${VIEWER_SCRIPT}</script>
</body>
</html>
`;
