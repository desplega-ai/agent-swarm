import { afterEach, expect, mock, test } from "bun:test";
import { randomUUID } from "./uuid";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
});

test("uses the native randomUUID with its Crypto receiver when available", () => {
  const id = "7a740751-439e-4d12-93f5-f99406f23155";
  const native = mock(function (this: Crypto) {
    expect(this).toBe(crypto);
    return id;
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: native },
  });
  expect(randomUUID()).toBe(id);
  expect(native).toHaveBeenCalledTimes(1);
});

test.each([
  [0x00, "00000000-0000-4000-8000-000000000000"],
  [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
])("formats random bytes as UUID v4 on HTTP origins (byte %i)", (byte, expected) => {
  const fill = mock((array: Uint8Array) => {
    expect(array).toBeInstanceOf(Uint8Array);
    expect(array.byteLength).toBe(16);
    array.fill(byte);
    return array;
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: fill },
  });
  expect(randomUUID()).toBe(expected);
  expect(fill).toHaveBeenCalledTimes(1);
});

test("requests fresh random bytes for every fallback UUID", () => {
  let nextByte = 0;
  const fill = mock((array: Uint8Array) => {
    array.fill(nextByte++);
    return array;
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: fill },
  });
  expect(randomUUID()).not.toBe(randomUUID());
  expect(fill).toHaveBeenCalledTimes(2);
});
