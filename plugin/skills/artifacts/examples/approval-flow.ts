import { createArtifactServer } from "../../src/artifact-sdk";
import { Hono } from "hono";

const app = new Hono();
app.get("/", (c) =>
  c.html(`
<!DOCTYPE html>
<html>
<head><title>Approval Required</title></head>
<body>
  <h1>PR #42 — Review Required</h1>
  <p>Agent wants to merge this PR. Please review.</p>
  <button id="approve">Approve</button>
  <button id="reject">Reject</button>
  <script src="/@swarm/sdk.js"></script>
  <script>
    const swarm = new SwarmSDK();
    document.getElementById('approve').onclick = async () => {
      await swarm.createTask({ task: 'Merge PR #42 — human approved' });
      document.body.innerHTML = '<h1>Approved! Task created.</h1>';
    };
    document.getElementById('reject').onclick = async () => {
      await swarm.createTask({ task: 'PR #42 rejected by human — needs changes' });
      document.body.innerHTML = '<h1>Rejected. Agent notified.</h1>';
    };
  </script>
</body>
</html>
`),
);

const server = createArtifactServer({ name: "approval-pr-42", app });
await server.start();
console.log(`Approval artifact at: ${server.url}`);
