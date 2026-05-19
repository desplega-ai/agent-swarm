/**
 * Defense-in-depth, not isolation. Accidental leaks through console.log,
 * JSON.stringify, util.inspect, or returned JSON emit "<redacted>". A malicious
 * script can still call Redacted.value() and exfiltrate the string; host-side
 * env stripping plus scrubObject are the v1 safety net.
 */
declare const redactedType: unique symbol;

export type Redacted<A> = object & { readonly [redactedType]?: A };

export type RedactedMeta = { type: "system" | "user"; isSecret: boolean };

const registry = new WeakMap<Redacted<unknown>, { value: unknown; meta: RedactedMeta }>();

const proto = {
  toString() {
    return "<redacted>";
  },
  toJSON() {
    return "<redacted>";
  },
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "<redacted>";
  },
};

function getEntry<A>(self: Redacted<A>): { value: unknown; meta: RedactedMeta } {
  const entry = registry.get(self);
  if (!entry) throw new Error("Redacted value was not in registry");
  return entry;
}

export const Redacted = {
  make<A>(value: A, meta: RedactedMeta = { type: "user", isSecret: false }): Redacted<A> {
    const redacted = Object.create(proto) as Redacted<A>;
    registry.set(redacted, { value, meta });
    return redacted;
  },
  value<A>(self: Redacted<A>): A {
    return getEntry(self).value as A;
  },
  meta<A>(self: Redacted<A>): RedactedMeta {
    return getEntry(self).meta;
  },
  isSecret<A>(self: Redacted<A>): boolean {
    return Redacted.meta(self).isSecret;
  },
} as const;
