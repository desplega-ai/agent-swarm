/** Shared JavaScript source for the native SDK and the QuickJS virtual module. */
export const DURABLE_OBJECT_BASE_JS = `class DurableObject {
  static __swarmDurable = true;
  state;
  constructor(id) {
    this._id = id;
    this._destroyed = false;
  }
  get id() { return this._id; }
  destroy() { this._destroyed = true; }
}`;

// Static methods and names that start with "_" are also not callable.
export const DURABLE_OBJECT_RESERVED_METHODS = new Set([
  "constructor",
  "initialState",
  "migrate",
  "destroy",
]);
