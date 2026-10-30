import { describe, expect, test } from "bun:test";
import {
  applyPending,
  boundedStringify,
  buildDraft,
  commitValue,
  createCommitQueue,
  type Doc,
  deriveControls,
  dropConfirmed,
  formSignature,
  fromSelectValue,
  isValidStateId,
  mergeSeed,
  type PendingProps,
  parseControlNumber,
  resolveMode,
  SCHEMA_FORM_MAX_DOC_ELEMENTS,
  SCHEMA_FORM_MAX_ENUM_OPTIONS,
  SCHEMA_FORM_MAX_PROPERTIES,
  SCHEMA_FORM_MAX_VALUE_DEPTH,
  toSelectValue,
  valuesEqual,
} from "./schema-form-model";

const schema = {
  properties: {
    title: { type: "string", description: "Heading" },
    count: { type: "number", default: 3 },
    on: { type: "boolean" },
    size: { enum: ["s", "m", 7] },
  },
};

function doc(): Doc {
  return {
    root: "a",
    elements: {
      a: { type: "Text", props: { title: "A", extra: 1 } },
      b: { type: "Text", props: { title: "B" } },
    },
  };
}

function props(value: unknown, key: string): unknown {
  return ((value as Doc).elements[key] as { props: unknown }).props;
}

describe("deriveControls", () => {
  test("derives one control per schema property with the right kind", () => {
    const { controls, truncated } = deriveControls(schema);
    expect(truncated).toBe(false);
    expect(controls.map((c) => [c.key, c.kind])).toEqual([
      ["title", "text"],
      ["count", "number"],
      ["on", "switch"],
      ["size", "select"],
    ]);
    expect(controls[0]?.description).toBe("Heading");
    expect(controls[3]?.options).toEqual(["s", "m"]);
  });

  test("an untrusted or empty schema yields no controls", () => {
    for (const bad of [undefined, null, "x", 3, [], {}, { properties: [] }, { properties: 1 }]) {
      expect(deriveControls(bad).controls).toEqual([]);
    }
  });

  test("a non-object property renders as a text control", () => {
    const { controls } = deriveControls({ properties: { a: null, b: 5 } });
    expect(controls.map((c) => c.kind)).toEqual(["text", "text"]);
  });

  test("skips a __proto__ property", () => {
    const hostile = JSON.parse('{"properties":{"__proto__":{"type":"string"},"ok":{}}}');
    expect(deriveControls(hostile).controls.map((c) => c.key)).toEqual(["ok"]);
  });

  test("caps the rendered properties", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < SCHEMA_FORM_MAX_PROPERTIES + 50; i++) properties[`p${i}`] = {};
    const { controls, truncated } = deriveControls({ properties });
    expect(controls).toHaveLength(SCHEMA_FORM_MAX_PROPERTIES);
    expect(truncated).toBe(true);
  });

  test("caps enum options", () => {
    const values = Array.from({ length: SCHEMA_FORM_MAX_ENUM_OPTIONS * 5 }, (_, i) => `v${i}`);
    const { controls } = deriveControls({ properties: { pick: { enum: values } } });
    expect(controls[0]?.options).toHaveLength(SCHEMA_FORM_MAX_ENUM_OPTIONS);
  });
});

describe("buildDraft", () => {
  const { controls } = deriveControls(schema);

  test("seeds from the value, falling back to the default", () => {
    expect(buildDraft(controls, { title: "Hi" })).toEqual({
      title: "Hi",
      count: 3,
      on: undefined,
      size: undefined,
    });
  });

  test("a non-object seed is treated as empty and inherited keys are ignored", () => {
    expect(buildDraft(controls, "nope").count).toBe(3);
    const inherited = Object.create({ title: "leak" });
    expect(buildDraft(controls, inherited).title).toBeUndefined();
  });
});

describe("resolveMode", () => {
  test("a doc with an own nodeKey is merge mode", () => {
    const base = doc();
    expect(resolveMode(base, "a")).toEqual({ kind: "merge", doc: base, nodeKey: "a" });
  });

  test("a missing doc, node key or element is flat mode", () => {
    expect(resolveMode(undefined, "a").kind).toBe("flat");
    expect(resolveMode({ elements: 1 }, "a").kind).toBe("flat");
    expect(resolveMode(doc(), undefined).kind).toBe("flat");
    expect(resolveMode(doc(), 4).kind).toBe("flat");
    expect(resolveMode(doc(), "zzz").kind).toBe("flat");
  });

  test("inherited and __proto__ node keys are not nodes", () => {
    expect(resolveMode(doc(), "__proto__").kind).toBe("flat");
    expect(resolveMode(doc(), "constructor").kind).toBe("flat");
    const own = JSON.parse('{"elements":{"__proto__":{"type":"Text","props":{}}}}');
    expect(resolveMode(own, "__proto__").kind).toBe("flat");
  });

  test("a doc over the element cap is refused", () => {
    const elements: Record<string, unknown> = { a: { type: "Text", props: {} } };
    for (let i = 0; i < SCHEMA_FORM_MAX_DOC_ELEMENTS; i++) elements[`k${i}`] = { type: "Text" };
    expect(resolveMode({ elements }, "a").kind).toBe("too-large");
  });
});

describe("commitValue", () => {
  test("flat mode writes the draft", () => {
    const draft = { title: "x" };
    expect(commitValue({ kind: "flat" }, new Map(), draft)).toBe(draft);
  });

  test("merge mode writes the merged doc and leaves the base untouched", () => {
    const base = doc();
    const mode = resolveMode(base, "a");
    const pending: PendingProps = new Map();
    const out = commitValue(mode, pending, { title: "A2" }) as Doc;
    // Props the schema does not list survive; the draft wins on the rest.
    expect(props(out, "a")).toEqual({ title: "A2", extra: 1 });
    expect(out.root).toBe("a");
    expect(props(out, "b")).toEqual({ title: "B" });
    expect(props(base, "a")).toEqual({ title: "A", extra: 1 });
  });

  test("two quick commits on different nodes both survive a stale baseDoc", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    commitValue(resolveMode(base, "a"), pending, { title: "A2" });
    const out = commitValue(resolveMode(base, "b"), pending, { title: "B2" }) as Doc;
    expect(props(out, "a")).toEqual({ title: "A2", extra: 1 });
    expect(props(out, "b")).toEqual({ title: "B2" });
  });

  test("the draft seeds from the overlay until the doc catches up", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    const mode = resolveMode(base, "a");
    if (mode.kind !== "merge") throw new Error("expected merge mode");
    expect(mergeSeed(mode, pending)).toEqual({ title: "A", extra: 1 });
    commitValue(mode, pending, { title: "A2" });
    expect(mergeSeed(mode, pending)).toEqual({ title: "A2", extra: 1 });
  });
});

describe("dropConfirmed", () => {
  test("drops the overlay once baseDoc catches up, keeps it before", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    commitValue(resolveMode(base, "a"), pending, { title: "A2" });

    dropConfirmed(pending, base);
    expect(pending.size).toBe(1);

    dropConfirmed(pending, applyPending(base, pending));
    expect(pending.size).toBe(0);
  });

  test("an unset schema key still confirms against a JSON round-tripped doc", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    // `count` was cleared: the draft carries it as undefined.
    commitValue(resolveMode(base, "a"), pending, { title: "A2", count: undefined });
    const served = JSON.parse(JSON.stringify(applyPending(base, pending)));
    dropConfirmed(pending, served);
    expect(pending.size).toBe(0);
  });

  test("an intermediate server version keeps the overlay of a later edit", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    commitValue(resolveMode(base, "a"), pending, { title: "A2" });
    const firstOnly = applyPending(base, new Map([["a", pending.get("a")!]]));
    commitValue(resolveMode(base, "a"), pending, { title: "A3" });
    dropConfirmed(pending, firstOnly);
    expect(pending.get("a")?.props.title).toBe("A3");
  });

  test("an overlay does not leak into a different document with the same node keys", () => {
    const pending: PendingProps = new Map();
    commitValue(resolveMode(doc(), "a"), pending, { title: "A2" });
    const other: Doc = { root: "a", elements: { a: { type: "Text", props: { title: "Z" } } } };
    dropConfirmed(pending, other);
    expect(pending.size).toBe(0);
    expect(props(applyPending(other, pending), "a")).toEqual({ title: "Z" });
  });

  test("drops the overlay of a node the doc no longer has, so a recreated node is not resurrected", () => {
    const base = doc();
    const pending: PendingProps = new Map();
    commitValue(resolveMode(base, "a"), pending, { title: "A2" });
    dropConfirmed(pending, { root: "b", elements: { b: base.elements.b } });
    expect(pending.size).toBe(0);
    dropConfirmed(pending, base);
    expect(props(applyPending(base, pending), "a")).toEqual({ title: "A", extra: 1 });
  });
});

describe("applyPending", () => {
  test("never writes a prototype key, even when the doc has an own __proto__ element", () => {
    const own = JSON.parse('{"elements":{"__proto__":{"type":"Text","props":{"t":1}},"a":{}}}');
    const pending: PendingProps = new Map([["__proto__", { props: { polluted: true }, seen: [] }]]);
    const out = applyPending(own, pending);
    expect(Object.getPrototypeOf(out.elements)).toBe(Object.prototype);
    expect((out.elements as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(out.elements, "__proto__")?.value).toEqual(
      Object.getOwnPropertyDescriptor(own.elements, "__proto__")?.value,
    );
  });

  test("skips an overlay entry for a node the doc does not have", () => {
    const pending: PendingProps = new Map([["gone", { props: { title: "x" }, seen: [] }]]);
    expect(Object.keys(applyPending(doc(), pending).elements)).toEqual(["a", "b"]);
  });

  test("shares untouched elements instead of cloning them", () => {
    const base = doc();
    const pending: PendingProps = new Map([["a", { props: { title: "A2" }, seen: [] }]]);
    const out = applyPending(base, pending);
    expect(out.elements.b).toBe(base.elements.b);
    expect(out.elements.a).not.toBe(base.elements.a);
  });
});

describe("controls", () => {
  test("number controls reject non-finite text and decimals on integer properties", () => {
    expect(parseControlNumber("Infinity", false)).toBeNull();
    expect(parseControlNumber("abc", false)).toBeNull();
    expect(parseControlNumber("1.5", false)).toEqual({ value: 1.5 });
    expect(parseControlNumber("1.5", true)).toBeNull();
    expect(parseControlNumber("4", true)).toEqual({ value: 4 });
    expect(parseControlNumber("", true)).toEqual({ value: undefined });
  });

  test("integer type is carried onto the control", () => {
    const { controls } = deriveControls({ properties: { n: { type: "integer" } } });
    expect(controls[0]).toMatchObject({ kind: "number", integer: true });
  });

  test("enum options are deduplicated and the empty option round-trips through the select value", () => {
    const { controls } = deriveControls({ properties: { p: { enum: ["a", "a", "", "b", "b"] } } });
    expect(controls[0]?.options).toEqual(["a", "", "b"]);
    expect(toSelectValue("")).not.toBe("");
    expect(fromSelectValue(toSelectValue(""))).toBe("");
    expect(toSelectValue(undefined)).toBe("");
    expect(toSelectValue("a")).toBe("a");
  });

  test("state ids are plain tokens", () => {
    expect(isValidStateId("props_1-a")).toBe(true);
    for (const bad of [
      "",
      "a/b",
      "a b",
      "../x",
      "__proto__",
      "constructor",
      "prototype",
      4,
      null,
    ]) {
      expect(isValidStateId(bad)).toBe(false);
    }
  });
});

describe("createCommitQueue", () => {
  test("a failing task is reported and does not block the next one", async () => {
    const errors: unknown[] = [];
    const enqueue = createCommitQueue((error) => errors.push(error));
    const order: string[] = [];
    const first = enqueue(async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = enqueue(async () => {
      order.push("second");
    });
    await expect(first).resolves.toBeUndefined();
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(errors).toHaveLength(1);
  });

  test("tasks run one at a time, in order", async () => {
    const enqueue = createCommitQueue(() => undefined);
    const order: string[] = [];
    const slow = enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("slow");
    });
    const fast = enqueue(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });
});

describe("valuesEqual", () => {
  test("treats undefined-valued keys as absent", () => {
    expect(valuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(valuesEqual({ a: 1, b: undefined }, { a: 1, c: 2 })).toBe(false);
  });
});

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { next: value };
  return value;
}

describe("bounded value walks", () => {
  test("valuesEqual compares plain values", () => {
    expect(valuesEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(valuesEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(valuesEqual([1], { 0: 1 })).toBe(false);
  });

  test("valuesEqual gives up past the depth cap instead of recursing", () => {
    const depth = SCHEMA_FORM_MAX_VALUE_DEPTH + 5;
    expect(valuesEqual(nested(depth), nested(depth))).toBe(false);
    expect(valuesEqual(nested(100_000), nested(100_000))).toBe(false);
  });

  test("valuesEqual gives up past the node budget", () => {
    const wide = Array.from({ length: 10_000 }, (_, i) => ({ i }));
    expect(valuesEqual(wide, structuredClone(wide))).toBe(false);
  });

  test("boundedStringify survives very deep and very wide values", () => {
    expect(boundedStringify(nested(100_000)).length).toBeLessThan(1000);
    const wide = Array.from({ length: 100_000 }, (_, i) => i);
    expect(boundedStringify(wide).length).toBeLessThan(40_000);
  });

  test("boundedStringify handles undefined, bigint and primitives", () => {
    expect(boundedStringify({ a: undefined, b: 1n, c: "x" })).toBe('{"a":null,"b":"1","c":"x"}');
  });

  test("formSignature changes with the seed and node key", () => {
    const { controls } = deriveControls(schema);
    const base = formSignature(controls, { title: "a" }, "a");
    expect(formSignature(controls, { title: "a" }, "a")).toBe(base);
    expect(formSignature(controls, { title: "b" }, "a")).not.toBe(base);
    expect(formSignature(controls, { title: "a" }, "b")).not.toBe(base);
  });

  test("a deeply nested seed on a many-element doc still merges", () => {
    const base = doc();
    (base.elements.a as { props: Record<string, unknown> }).props.deep = nested(100_000);
    const pending: PendingProps = new Map();
    const out = commitValue(resolveMode(base, "a"), pending, { title: "A2" }) as Doc;
    expect((props(out, "a") as { title: string }).title).toBe("A2");
    dropConfirmed(pending, base);
    expect(pending.size).toBe(1);
  });
});
