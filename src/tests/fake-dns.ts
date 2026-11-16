import { mock } from "bun:test";
import * as realDns from "node:dns/promises";

/**
 * Import first in a test file whose code resolves hostnames through
 * `node:dns/promises` (the guarded fetches in src/utils/egress-guard.ts).
 * Reserved example names (RFC 2606 / RFC 6761: example.com, .example, .test,
 * .invalid) resolve in-process to a public address, so those tests never
 * touch real DNS. `setFakeDnsAnswer` pins a name to other addresses. Every
 * other name goes to the real resolver, so the mock is harmless to files that
 * share the process.
 */

export const FAKE_PUBLIC_ADDRESS = "93.184.216.34";

const answers = new Map<string, string[]>();

export function setFakeDnsAnswer(hostname: string, addresses: string[]): void {
  answers.set(hostname.toLowerCase(), addresses);
}

function isReservedName(hostname: string): boolean {
  return (
    hostname === "example.com" ||
    hostname.endsWith(".example.com") ||
    /\.(example|test|invalid)$/.test(hostname)
  );
}

const lookup = (async (hostname: string, options?: unknown) => {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  const addresses = answers.get(name) ?? (isReservedName(name) ? [FAKE_PUBLIC_ADDRESS] : null);
  if (!addresses) {
    return (realDns.lookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options);
  }
  const records = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  return (options as { all?: boolean } | undefined)?.all ? records : records[0];
}) as typeof realDns.lookup;

mock.module("node:dns/promises", () => ({
  ...realDns,
  lookup,
  default: { ...realDns, lookup },
}));
