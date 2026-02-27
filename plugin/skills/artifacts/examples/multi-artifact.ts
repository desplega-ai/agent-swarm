import { createArtifactServer } from "../../src/artifact-sdk";
import { Hono } from "hono";

// Artifact 1: Status page
const statusApp = new Hono();
statusApp.get("/", (c) => c.html("<h1>Status: All systems operational</h1>"));

// Artifact 2: Data viewer
const dataApp = new Hono();
dataApp.get("/", (c) => c.json({ items: [1, 2, 3], generated: new Date().toISOString() }));

const status = createArtifactServer({ name: "status", app: statusApp });
const data = createArtifactServer({ name: "data", app: dataApp });

await status.start();
await data.start();

console.log(`Status page: ${status.url}`);
console.log(`Data viewer: ${data.url}`);
console.log(`Both artifacts running on different ports (${status.port}, ${data.port})`);
