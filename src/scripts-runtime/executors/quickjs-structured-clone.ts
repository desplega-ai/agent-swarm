/** Runs inside QuickJS, before user code; cloned values never cross the host bridge. */
export const SANDBOX_STRUCTURED_CLONE = `(() => {
"use strict";

// Capture intrinsics before a script can replace methods, constructors or accessors.
const uncurry = (fn) => Function.prototype.call.bind(fn);
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const keys = Object.keys;
const hasOwn = uncurry(Object.prototype.hasOwnProperty);
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const isError = Error.isError;
const instanceOf = uncurry(Function.prototype[Symbol.hasInstance]);
const NativeObject = Object;
const NativeArray = Array;
const NativeError = Error;
const NativeTypeError = TypeError;
const NativeMap = Map;
const NativeSet = Set;
const NativeWeakMap = WeakMap;
const NativeArrayBuffer = ArrayBuffer;
const NativeUint8Array = Uint8Array;
const NativeDataView = DataView;
const NativeDate = Date;
const NativeRegExp = RegExp;
const regexpPrototype = RegExp.prototype;
const toString = String;
const mapHas = uncurry(Map.prototype.has);
const mapSet = uncurry(Map.prototype.set);
const mapForEach = uncurry(Map.prototype.forEach);
const setHas = uncurry(Set.prototype.has);
const setAdd = uncurry(Set.prototype.add);
const setForEach = uncurry(Set.prototype.forEach);
const memoHas = uncurry(WeakMap.prototype.has);
const memoGet = uncurry(WeakMap.prototype.get);
const memoSet = uncurry(WeakMap.prototype.set);
const dateValue = uncurry(Date.prototype.getTime);
const regexpSource = uncurry(descriptor(RegExp.prototype, "source").get);
const bufferLength = uncurry(descriptor(ArrayBuffer.prototype, "byteLength").get);
const bufferResizable = uncurry(descriptor(ArrayBuffer.prototype, "resizable").get);
const dataBuffer = uncurry(descriptor(DataView.prototype, "buffer").get);
const dataOffset = uncurry(descriptor(DataView.prototype, "byteOffset").get);
const dataLength = uncurry(descriptor(DataView.prototype, "byteLength").get);
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedName = uncurry(descriptor(typedPrototype, Symbol.toStringTag).get);
const typedBuffer = uncurry(descriptor(typedPrototype, "buffer").get);
const typedOffset = uncurry(descriptor(typedPrototype, "byteOffset").get);
const typedLength = uncurry(descriptor(typedPrototype, "length").get);
const typedValues = uncurry(typedPrototype.values);
const setBytes = uncurry(Uint8Array.prototype.set);
const errorTypes = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const viewTypes = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float16Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};
const boxedValues = [Boolean, Number, String, BigInt, Symbol].map(Type => uncurry(Type.prototype.valueOf));
const regexpFlags = [
  ["hasIndices", "d"], ["global", "g"], ["ignoreCase", "i"], ["multiline", "m"],
  ["dotAll", "s"], ["unicode", "u"], ["unicodeSets", "v"], ["sticky", "y"],
].map(([name, flag]) => [uncurry(descriptor(RegExp.prototype, name).get), flag]);
const unsupportedTypes = [Promise, WeakMap, WeakSet, WeakRef, FinalizationRegistry, SharedArrayBuffer];
const brandKey = {};
const noBrand = {};
const probe = (read, value) => {
  try { return read(value); } catch { return noBrand; }
};
const fail = (message = "Value cannot be cloned") => {
  const error = new NativeError(message);
  error.name = "DataCloneError";
  throw error;
};
const property = (target, key, value) => define(target, key, {
  value, enumerable: true, writable: true, configurable: true,
});

function structuredClone(value, options) {
  if (arguments.length === 0) throw new NativeTypeError("structuredClone requires a value");
  // QuickJS has no transferable host objects. Reject rather than silently ignoring detachment.
  const transfer = options == null ? undefined : options.transfer;
  if (transfer !== undefined) {
    for (const entry of transfer) fail("quickjs structuredClone does not support transfers");
  }
  const memory = new NativeWeakMap();
  const remember = (source, target) => { memoSet(memory, source, target); return target; };
  const clone = (source) => {
    const type = typeof source;
    if (type === "symbol" || type === "function") return fail();
    if (source === null || type !== "object") return source;
    if (memoHas(memory, source)) return memoGet(memory, source);

    if (isView(source)) {
      const name = typedName(source);
      if (name !== undefined) {
        // The intrinsic rejects detached or out-of-bounds views; property getters may lie.
        try { typedValues(source); } catch { return fail(); }
        return remember(source, new viewTypes[name](clone(typedBuffer(source)), typedOffset(source), typedLength(source)));
      }
      let buffer, offset, length;
      try { buffer = dataBuffer(source); offset = dataOffset(source); length = dataLength(source); }
      catch { return fail(); }
      return remember(source, new NativeDataView(clone(buffer), offset, length));
    }

    const byteLength = probe(bufferLength, source);
    if (byteLength !== noBrand) {
      let bytes;
      try { bytes = new NativeUint8Array(source); } catch { return fail(); }
      // JS cannot recover whether a view over a resizable buffer tracks its length.
      if (bufferResizable(source)) return fail("quickjs structuredClone does not support resizable buffers");
      const target = new NativeArrayBuffer(byteLength);
      setBytes(new NativeUint8Array(target), bytes);
      return remember(source, target);
    }

    if (isError(source)) {
      const name = source.name;
      const Type = typeof name === "string" && hasOwn(errorTypes, name) ? errorTypes[name] : NativeError;
      const target = remember(source, new Type());
      const message = descriptor(source, "message");
      if (message && hasOwn(message, "value")) {
        if (typeof message.value === "symbol") throw new NativeTypeError("Cannot convert a Symbol value to a string");
        define(target, "message", { value: toString(message.value), writable: true, configurable: true });
      }
      const stack = descriptor(source, "stack");
      if (stack && typeof stack.value === "string") {
        define(target, "stack", { value: stack.value, writable: true, configurable: true });
      }
      return target;
    }

    if (probe((value) => mapHas(value, brandKey), source) !== noBrand) {
      const target = remember(source, new NativeMap());
      // Snapshot entries before cloning any value: getters can mutate the original collection.
      const entries = [];
      mapForEach(source, (value, key) => { entries[entries.length] = [key, value]; });
      for (let i = 0; i < entries.length; i++) mapSet(target, clone(entries[i][0]), clone(entries[i][1]));
      return target;
    }
    if (probe((value) => setHas(value, brandKey), source) !== noBrand) {
      const target = remember(source, new NativeSet());
      const entries = [];
      setForEach(source, value => { entries[entries.length] = value; });
      for (let i = 0; i < entries.length; i++) setAdd(target, clone(entries[i]));
      return target;
    }
    const time = probe(dateValue, source);
    if (time !== noBrand) return remember(source, new NativeDate(time));
    const pattern = source === regexpPrototype ? noBrand : probe(regexpSource, source);
    if (pattern !== noBrand) {
      let flags = "";
      for (let i = 0; i < regexpFlags.length; i++) {
        if (regexpFlags[i][0](source)) flags += regexpFlags[i][1];
      }
      return remember(source, new NativeRegExp(pattern, flags));
    }
    for (let i = 0; i < boxedValues.length; i++) {
      const primitive = probe(boxedValues[i], source);
      if (primitive !== noBrand) {
        if (typeof primitive === "symbol") return fail();
        return remember(source, NativeObject(primitive));
      }
    }
    for (let i = 0; i < unsupportedTypes.length; i++) {
      if (instanceOf(unsupportedTypes[i], source)) return fail();
    }

    const target = remember(source, isArray(source) ? new NativeArray(source.length) : {});
    const names = keys(source);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      // A prior getter can delete a later property. Symbol keys are never read.
      if (hasOwn(source, name)) property(target, name, clone(source[name]));
    }
    return target;
  };
  return clone(value);
}
define(globalThis, "structuredClone", { value: structuredClone, writable: true, configurable: true });
})();`;
