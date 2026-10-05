import { runInNewContext } from "node:vm";

type Listener = (event: Record<string, unknown>) => void;

/** The parts of a DOM element the viewer script touches. */
export class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  textContent = "";
  src = "";
  alt = "";
  clientWidth = 800;
  clientHeight = 400;
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setPointerCapture(): void {}

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const IDS = ["stage", "diagram", "name", "status", "dark", "fit", "zoom-in", "zoom-out"] as const;

export interface LoadedViewer {
  elements: Record<(typeof IDS)[number], FakeElement>;
  root: FakeElement;
  window: FakeElement;
  /** Messages the view posted to its host. */
  posted: Record<string, unknown>[];
  /** Delivers a message as the host would; `source` other than the host is a stranger frame. */
  receive(data: unknown, source?: unknown): void;
  /** Lets promise callbacks run. */
  settle(): Promise<void>;
}

/**
 * Runs the `<script>` of the viewer page in a VM context with a fake DOM and host frame, so a test
 * drives the MCP Apps handshake and checks what the page shows. Fails if the page has no script.
 */
export function loadViewer(html: string): LoadedViewer {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error("the viewer page has no inline script");
  const elements = Object.fromEntries(IDS.map((id) => [id, new FakeElement()])) as Record<
    (typeof IDS)[number],
    FakeElement
  >;
  const root = new FakeElement();
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
  const window = Object.assign(new FakeElement(), { parent });
  runInNewContext(script, {
    window,
    document: {
      getElementById: (id: string) => elements[id as (typeof IDS)[number]],
      documentElement: root,
    },
  });
  return {
    elements,
    root,
    window,
    posted,
    receive: (data, source = parent) => window.dispatch("message", { data, source }),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}
