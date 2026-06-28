import "@swarm/ai-llm";

// The server bootstrap (createServer + httpServer.listen side effects) lives in
// @swarm/api-server's http/index entry. It is intentionally NOT re-exported from
// the package barrel (importing the bare barrel must not boot a server), so the
// apps/api entry reaches it by path until the apps split extracts this bootstrap.
import "../../../packages/api-server/src/http/index";
