import type { StarUMLClient } from "./staruml-client.js";

/** An element as extension 0.3.0 summarizes it (src/serialize.ts `summarize`). */
interface Summary {
  _id: string;
  _type: string;
  name?: string | null;
  _parent?: string | null;
}

interface Page {
  elements: Summary[];
  nextCursor?: string | null;
}

export interface TreeNode {
  _id: string;
  _type: string;
  name?: string;
  children?: TreeNode[];
}

/** The extension's maximum page size; a 1,000-element project is read in one request. */
const PAGE_SIZE = 1000;

/**
 * The project's ownership tree, built from `/find_elements` summaries. `Model` matches every model
 * element and diagram (subtypes included) but no views, which would multiply the size without
 * telling a reader anything the diagram does not.
 */
export async function readProjectTree(client: StarUMLClient): Promise<TreeNode[]> {
  const elements: Summary[] = [];
  let cursor: string | undefined;
  do {
    const page = (await client.callExtension("/find_elements", {
      type: "Model",
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    })) as Page;
    elements.push(...page.elements);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return buildTree(elements);
}

/** Roots are elements whose owner is null or was not returned; sibling order is kept. */
export function buildTree(elements: readonly Summary[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const e of elements) {
    nodes.set(e._id, { _id: e._id, _type: e._type, ...(e.name ? { name: e.name } : {}) });
  }
  const roots: TreeNode[] = [];
  for (const e of elements) {
    const node = nodes.get(e._id)!;
    const parent = e._parent == null ? undefined : nodes.get(e._parent);
    if (parent === undefined) {
      roots.push(node);
    } else {
      (parent.children ??= []).push(node);
    }
  }
  return roots;
}
