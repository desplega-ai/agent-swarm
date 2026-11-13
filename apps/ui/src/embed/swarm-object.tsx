// Entry of the `<swarm-object>` page bundle (`vite.embed.config.ts` builds it
// to `embed/v1/swarm-object.js`). The CSS imports land in `swarm-object.css`,
// which the element links inside its shadow root, never in the page's <head>.
import "@/styles/globals.css";
import "@/styles/ag-grid.css";
import { defineSwarmObject } from "./swarm-object-element";

// The folder this script was served from, on the dashboard origin. String
// math, not `new URL(…, import.meta.url)`, which Vite would try to bundle.
const base = import.meta.url.replace(/[^/]*$/, "");

defineSwarmObject({
  stylesheet: `${base}swarm-object.css`,
  documentStylesheet: `${base}swarm-object-global.css`,
  appOrigin: new URL(base).origin,
});
