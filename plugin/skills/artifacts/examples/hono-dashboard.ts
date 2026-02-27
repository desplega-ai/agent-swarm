import { createArtifactServer } from "../../src/artifact-sdk";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) =>
  c.html(`
<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <h1>Agent Dashboard</h1>
  <div id="agents"></div>
  <script src="/@swarm/sdk.js"></script>
  <script>
    const swarm = new SwarmSDK();
    swarm.getSwarm().then(agents => {
      document.getElementById('agents').innerHTML =
        '<ul>' + agents.map(a => '<li>' + a.name + ' (' + a.status + ')</li>').join('') + '</ul>';
    });
  </script>
</body>
</html>
`),
);

app.get("/api/status", (c) => c.json({ status: "ok", timestamp: Date.now() }));

const server = createArtifactServer({ name: "dashboard", app });
await server.start();
console.log(`Dashboard live at: ${server.url}`);
