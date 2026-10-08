#!/usr/bin/env node
// Records what a running StarUML answers while one domain is turned into diagrams two ways, for
// the "model a domain: oo tier against drawing" part of scripts/token-benchmark.mjs. The domain
// is the ThingsBoard object spec of the extension's validation (tests/fixtures/thingsboard.oo.json:
// 93 classifiers in 15 contexts, 95 relationships, actors, use cases, collaborations, lifecycles
// and the view sections for activity, ERD, C4, deployment and mind map diagrams).
//
// - oo (#17): /build_model with the spec, /derive_diagrams of the model; /derive_diagrams once
//   more, which must change nothing (the determinism the issue asks for);
// - drawing: one /build_diagram per diagram, each spec written from the same domain knowledge
//   the way a model draws without the oo tier: every class with its members, every relation with
//   its multiplicities, every message, state and node spelt out ({@link drawingCalls}).
//
// Each way works in a model of its own, deleted at the end.
//
// Usage: node scripts/capture-oo.mjs [--url http://localhost] [--spec <file>] (needs StarUML 7
// with staruml-mcp-extension 0.3 with /derive_diagrams on 58322; STARUML_EXT_TOKEN is sent when
// set). The real build took 20 s on an idle StarUML 7.1.1.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost" },
    spec: {
      type: "string",
      default: new URL("../tests/fixtures/thingsboard.oo.json", import.meta.url).pathname,
    },
  },
});

async function ext(path, body = {}) {
  const res = await fetch(`${args.url}:58322${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.STARUML_EXT_TOKEN
        ? { Authorization: `Bearer ${process.env.STARUML_EXT_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.success !== true) {
    throw new Error(`${path} answered HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

/** build_model's relationship verbs as build_diagram's relation types (the manifest's table). */
const VERBS = {
  owns: "composition",
  has: "aggregation",
  uses: "dependency",
  isA: "generalization",
  implements: "realization",
  knows: "directed",
};

const nameOf = (item) => (typeof item === "string" ? item : item.name);
/** `[a, b, c]` or `{a, b, c}` as an object with these fields. */
const tuple = (value, fields) =>
  Array.isArray(value)
    ? Object.fromEntries(value.flatMap((v, i) => (v === undefined ? [] : [[fields[i], v]])))
    : value;

/**
 * The build_diagram calls that draw what derive_diagrams derives from `spec`: a package
 * overview, a class diagram per class view (or per context), a sequence diagram per
 * collaboration, a use case diagram per use case view, a state machine per lifecycle, and the
 * view sections as they stand. A model drawing them has nothing to reuse but names, so each
 * class diagram lists its classes' members.
 */
function drawingCalls(spec, parent) {
  const contexts = (spec.contexts ?? []).map((c) => (typeof c === "string" ? { name: c } : c));
  const contextId = (c) => c.id ?? c.name;
  const inContext = (ids) =>
    spec.classes.filter((c) =>
      ids.some((id) => {
        const ctx = contexts.find((x) => contextId(x) === id || x.name === id);
        return ctx !== undefined && c.context === contextId(ctx);
      }),
    );
  const classDiagram = (name, classes) => {
    const names = new Set(classes.map((c) => c.name));
    return {
      kind: "class",
      name,
      parent,
      spec: {
        classes: classes.map(({ name: n, kind, stereotype, attributes, operations, literals }) => ({
          name: n,
          ...(kind && kind !== "class" && { kind }),
          ...(stereotype && { stereotype }),
          ...(attributes && { attributes }),
          ...(operations && { operations }),
          ...(literals && { literals }),
        })),
        relations: (spec.relationships ?? [])
          .filter((r) => names.has(r.from) && names.has(r.to))
          .map((r) => ({
            from: r.from,
            to: r.to,
            type: VERBS[r.type] ?? r.type,
            ...(r.fromMult && { fromMultiplicity: r.fromMult }),
            ...(r.toMult && { toMultiplicity: r.toMult }),
          })),
      },
    };
  };
  const views = spec.classViews?.length
    ? spec.classViews.map((v) => {
        const members = new Set([...(v.classes ?? []), ...(v.also ?? [])]);
        const exclude = new Set(v.exclude ?? []);
        const classes = [
          ...inContext(v.contexts ?? []),
          ...spec.classes.filter((c) => members.has(c.name)),
        ].filter((c, i, all) => !exclude.has(c.name) && all.indexOf(c) === i);
        return classDiagram(v.name, classes);
      })
    : contexts.map((c) => classDiagram(c.name, inContext([contextId(c)])));
  const useCases = (spec.useCases ?? []).map((u) => (typeof u === "string" ? { name: u } : u));
  const usecaseViews = (spec.useCaseViews ?? []).map((v) => {
    const actors = [v.actor, ...(v.actors ?? []), ...(v.extraActors ?? [])].filter(Boolean);
    const cases = useCases.filter((u) => (v.cases ?? []).includes(u.name));
    return {
      kind: "usecase",
      name: v.name,
      parent,
      // An actor named like a class of the domain (ThingsBoard's Device) is a second element:
      // the drawn model has both in one package, where build_diagram refuses the name otherwise.
      allowDuplicateNames: true,
      spec: {
        ...(cases.find((u) => u.system)?.system && { system: cases.find((u) => u.system).system }),
        actors,
        useCases: cases.map((u) => u.name),
        relations: cases.flatMap((u) => [
          ...(u.actors ?? [])
            .filter((a) => actors.includes(a))
            .map((a) => ({ from: a, to: u.name })),
          // Only between cases the view shows; the rest are other views' business.
          ...(u.includes ?? [])
            .filter((to) => v.cases.includes(to))
            .map((to) => ({ from: u.name, to, type: "include" })),
          ...(u.extends ?? [])
            .filter((to) => v.cases.includes(to))
            .map((to) => ({ from: u.name, to, type: "extend" })),
        ]),
      },
    };
  });
  return [
    {
      kind: "package",
      name: `${spec.system} packages`,
      parent,
      spec: {
        packages: contexts.map((c) => ({
          name: c.name,
          ...(c.parent && {
            parent: nameOf(contexts.find((x) => contextId(x) === c.parent) ?? c.parent),
          }),
        })),
        dependencies: contexts.flatMap((c) =>
          (c.dependsOn ?? []).map((d) => ({
            from: c.name,
            to: nameOf(contexts.find((x) => contextId(x) === d) ?? d),
          })),
        ),
      },
    },
    ...views,
    ...(spec.collaborations ?? []).map((c) => ({
      kind: "sequence",
      name: c.name,
      parent,
      spec: {
        participants: c.participants,
        messages: c.messages.map((m) => tuple(m, ["from", "to", "text", "kind"])),
        ...(c.fragments && { fragments: c.fragments }),
      },
    })),
    ...usecaseViews,
    ...(spec.lifecycles ?? []).map((l) => ({
      kind: "statemachine",
      name: l.name,
      parent,
      spec: { states: l.states, transitions: l.transitions },
    })),
    ...(spec.activities ?? []).map((a) => ({
      kind: "activity",
      name: a.name,
      parent,
      spec: {
        ...(a.lanes && { lanes: a.lanes }),
        nodes: a.nodes,
        flows: a.flows.map((f) => tuple(f, ["from", "to", "guard"])),
      },
    })),
    ...(spec.erd
      ? [
          {
            kind: "erd",
            name: spec.erd.name ?? `${spec.system} data model`,
            parent,
            spec: {
              entities: spec.erd.entities,
              relationships: (spec.erd.relationships ?? []).map((r) =>
                tuple(r, ["from", "to", "fromCardinality", "toCardinality", "name"]),
              ),
            },
          },
        ]
      : []),
    ...(spec.components
      ? [
          {
            kind: "c4",
            name: spec.components.name ?? `${spec.system} containers`,
            parent,
            spec: {
              elements: spec.components.elements,
              relations: (spec.components.relations ?? []).map((r) =>
                tuple(r, ["from", "to", "label", "technology", "description"]),
              ),
            },
          },
        ]
      : []),
    ...(spec.deployments ?? []).map((d) => ({
      kind: "deployment",
      name: d.name,
      parent,
      spec: {
        nodes: d.nodes.map((n) => ({
          name: n.name,
          ...(n.kind && n.kind !== "node" && { stereotype: n.kind }),
          ...(n.contains && { deploys: n.contains }),
        })),
        artifacts: [...new Set(d.nodes.flatMap((n) => n.contains ?? []))],
        paths: (d.links ?? []).map((l) => tuple(l, ["from", "to", "name"])),
      },
    })),
    ...(spec.features
      ? [{ kind: "mindmap", name: spec.features.name, parent, spec: { root: spec.features } }]
      : []),
  ];
}

const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const seconds = (since) => Math.round((performance.now() - since) / 100) / 10;
const cleanup = [];
try {
  let started = performance.now();
  const built = await ext("/build_model", { spec });
  cleanup.push(built.model._id);
  const derive = { scope: spec.system };
  const derived = await ext("/derive_diagrams", derive);
  const oo = { seconds: seconds(started), build: built, derive, derived };
  const again = await ext("/derive_diagrams", derive);
  await ext("/delete_element", { ref: cleanup.pop() });

  started = performance.now();
  const model = await ext("/create_element", {
    type: "UMLModel",
    parent: "@project",
    name: `${spec.system} drawn`,
  });
  cleanup.push(model._id);
  const drawing = [];
  for (const call of drawingCalls(spec, model._id)) {
    drawing.push({ args: call, answer: await ext("/build_diagram", call) });
  }
  const drawn = { seconds: seconds(started), calls: drawing };

  const versions = await ext("/introspect", { include: [] });
  const out = new URL("benchmark-data/oo-thingsboard-7.1.1.json", import.meta.url);
  writeFileSync(out, `${JSON.stringify({ versions, spec, oo, again, drawn }, null, 2)}\n`);
  const scores = derived.diagrams.map((d) => d.quality?.score).filter((s) => s !== undefined);
  console.log(
    `Wrote ${out.pathname}: oo ${derived.counts.diagrams} diagrams in 2 calls (${oo.seconds} s, ` +
      `scores ${Math.min(...scores)}-${Math.max(...scores)}); derive again created ` +
      `${again.counts.created}, updated ${again.counts.updated}, deleted ${again.counts.deleted}; ` +
      `drawing ${drawing.length} build_diagram calls (${drawn.seconds} s).`,
  );
} finally {
  // A failed clean-up must not hide the error that got here.
  for (const ref of cleanup) {
    await ext("/delete_element", { ref }).catch((error) =>
      console.error(`Could not delete ${ref}: ${error.message}`),
    );
  }
}
