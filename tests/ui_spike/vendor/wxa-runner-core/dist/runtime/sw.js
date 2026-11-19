"use strict";
(() => {
  // src/runtime/networkPanel.ts
  var MOCK_PREFIX = "/__wxa__/mock/";
  var MOCK_ID_HEADER = "x-wxa-mock-id";
  function toHeaders(header) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(header)) {
      if (value === void 0 || value === null) continue;
      try {
        headers.set(name, String(value));
      } catch {
      }
    }
    return headers;
  }

  // src/runtime/mockResponse.ts
  var NULL_BODY_STATUSES = /* @__PURE__ */ new Set([204, 205, 304]);
  async function mockedResponse(client, id) {
    if (!client) return Response.error();
    const reply = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        resolve(event.data);
      };
      client.postMessage({ type: "wxa-mock-response", id }, [channel.port2]);
    });
    if (!reply) return Response.error();
    try {
      return new Response(NULL_BODY_STATUSES.has(reply.statusCode) ? null : reply.body, {
        status: reply.statusCode,
        headers: toHeaders(reply.header)
      });
    } catch {
      return Response.error();
    }
  }

  // src/runtime/sw.ts
  var scope = self;
  var URLPatternClass = globalThis.URLPattern;
  scope.addEventListener("install", (event) => {
    scope.skipWaiting();
    if (!event.addRoutes || !URLPatternClass) return;
    const others = { not: { urlPattern: new URLPatternClass({ pathname: `${MOCK_PREFIX}*` }) } };
    try {
      event.waitUntil(event.addRoutes([{ condition: others, source: "network" }]).catch(() => void 0));
    } catch {
    }
  });
  scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
  scope.addEventListener("fetch", (event) => {
    const id = event.request.headers.get(MOCK_ID_HEADER);
    if (!id || !new URL(event.request.url).pathname.startsWith(MOCK_PREFIX)) return;
    event.respondWith(scope.clients.get(event.clientId).then((client) => mockedResponse(client, id)));
  });
})();
//# sourceMappingURL=sw.js.map