/**
 * tests/test-capabilities.mjs
 *
 * Verifies the first kernel seam for the bottom-up refactor: HTTP routes can be
 * introspected without exposing handler implementations. MCP should eventually
 * derive its advertised capabilities from this surface instead of hardcoding
 * imaginary endpoints.
 */

import { HTTPRouter } from "../src/core/http-router.mjs";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

console.log("=== korina capabilities seam test ===");

const router = new HTTPRouter({ port: 0 });
router.post("/zeta", () => ({ ok: true }));
router.get("/alpha", () => ({ ok: true }));
router.delete("/alpha", () => ({ ok: true }));

const routes = router.listRoutes();
console.log("  routes:", JSON.stringify(routes));

assert(Array.isArray(routes), "listRoutes() returns an array");
assert(routes.length === 3, `route count is 3 (actual ${routes.length})`);
assert(routes[0].path === "/alpha" && routes[0].method === "DELETE", "routes are sorted by path then method");
assert(routes[1].path === "/alpha" && routes[1].method === "GET", "GET /alpha present");
assert(routes[2].path === "/zeta" && routes[2].method === "POST", "POST /zeta present");
assert(!Object.prototype.hasOwnProperty.call(routes[0], "handler"), "handler implementation is not exposed");

console.log(`\n=== result: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
