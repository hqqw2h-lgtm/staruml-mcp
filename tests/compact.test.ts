import { describe, expect, it } from "vitest";
import { OK, omitEcho, prune, serialize } from "../src/compact.js";

describe("prune", () => {
  it.each([
    ["a string", "x"],
    ["an empty string", ""],
    ["zero", 0],
    ["false", false],
    ["null", null],
    ["undefined", undefined],
  ])("returns %s unchanged", (_label, value) => {
    expect(prune(value)).toBe(value);
  });

  it("drops null, undefined, empty array and empty object properties", () => {
    expect(
      prune({ a: null, b: undefined, c: [], d: {}, e: "", f: 0, g: false, h: [0], i: { j: 1 } }),
    ).toEqual({ e: "", f: 0, g: false, h: [0], i: { j: 1 } });
  });

  it("prunes every object inside arrays and nested objects", () => {
    expect(prune([{ a: null, b: 1 }, { c: { d: [], e: 2 } }])).toEqual([{ b: 1 }, { c: { e: 2 } }]);
  });

  it("keeps array items, including null and empty ones, in place", () => {
    expect(prune([null, [], {}, 1])).toEqual([null, [], {}, 1]);
  });

  it("keeps an object whose properties were all pruned as {}", () => {
    expect(prune({ owner: { stereotype: null } })).toEqual({ owner: {} });
  });

  it("does not mutate its input", () => {
    const input = { a: null, b: [{ c: null }] };
    prune(input);
    expect(input).toEqual({ a: null, b: [{ c: null }] });
  });
});

describe("omitEcho", () => {
  it("drops top-level properties equal to a primitive argument of the same name", () => {
    expect(
      omitEcho(
        { id: "X", filename: "/a.mdj", count: 1, flag: true, other: "/a.mdj" },
        { id: "X", filename: "/a.mdj", count: 1, flag: true },
      ),
    ).toEqual({ other: "/a.mdj" });
  });

  it("keeps properties whose value differs from the argument", () => {
    expect(omitEcho({ filename: "/saved.mdj" }, { filename: "/asked.mdj" })).toEqual({
      filename: "/saved.mdj",
    });
  });

  it("never treats object, array or null arguments as echoes", () => {
    const shared = { x: 1 };
    expect(omitEcho({ o: shared, a: null }, { o: shared, a: null })).toEqual({
      o: shared,
      a: null,
    });
  });

  it("ignores undefined arguments", () => {
    expect(omitEcho({ name: undefined, n: 1 }, { name: undefined })).toEqual({
      name: undefined,
      n: 1,
    });
  });

  it("only looks at the top level", () => {
    expect(omitEcho({ model: { name: "A" } }, { name: "A" })).toEqual({ model: { name: "A" } });
  });

  it.each([[["X"]], ["X"], [null], [undefined]])("returns non-object %j unchanged", (value) => {
    expect(omitEcho(value, { id: "X" })).toBe(value);
  });
});

describe("serialize", () => {
  it("writes minified JSON", () => {
    expect(serialize({ a: [1, 2], b: { c: "d" } })).toBe('{"a":[1,2],"b":{"c":"d"}}');
  });

  it("prunes before echo removal", () => {
    expect(serialize({ id: "X", result: null, tags: [] }, { id: "X" })).toBe(OK);
  });

  it.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["an object with only empty properties", { a: null, b: [] }],
  ])("reports ok for %s", (_label, value) => {
    expect(serialize(value)).toBe("ok");
  });

  it.each([
    ["null", null, "null"],
    ["an empty array", [], "[]"],
    ["a string", "s", '"s"'],
    ["a number", 3, "3"],
  ])("keeps %s as an answer", (_label, value, expected) => {
    expect(serialize(value)).toBe(expected);
  });
});
