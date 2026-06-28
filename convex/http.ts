import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

// ============================================================================
// INTERCEPT — HTTP endpoints. Just a liveness probe for now; the swarm runs over
// the Convex client API, not HTTP.
// ============================================================================

const http = httpRouter();

// GET /health -> "ok". Used by uptime checks and the demo smoke test.
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }),
});

export default http;
