import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "../src/server.mjs";

test("keeps the example credential blank", async () => {
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /^BRAVE_SEARCH_API_KEY=\r?$/m);
  assert.match(example, /^HORIZON_ENABLE_HSTS=false\r?$/m);
  assert.match(example, /^HORIZON_BASIC_AUTH_USER=\r?$/m);
  assert.match(example, /^HORIZON_BASIC_AUTH_PASSWORD=\r?$/m);
});

test("rejects malformed search objects and control characters before calling the provider", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    for (const body of [
      null, [], "test", { query: 123 }, { query: {} },
      { query: "test", id: "someone-else" },
      { query: "test", name: "'; DROP TABLE users;--" },
      { query: "test", __proto__: null, constructor: {} },
      { query: "x".repeat(401) }, { query: `${" ".repeat(401)}test` },
      { query: "test\u0000query" }, { query: "test\u001bquery" },
    ]) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST", headers: searchHeaders(origin), body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    const malformed = await fetch(`${origin}/api/search`, {
      method: "POST", headers: searchHeaders(origin), body: "{not json}",
    });
    assert.equal(malformed.status, 400);
    assert.equal(providerCalls, 0);
  });
});

test("enforces body size limits even without a content length", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => { providerCalls += 1; return Response.json({ web: { results: [] } }); },
  }, async (origin) => {
    const body = JSON.stringify({ query: "x".repeat(5000) });
    const headers = searchHeaders(origin);
    assert.equal(await sendRawRequest(`${origin}/api/search`, {
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, body,
    }), 413);
    assert.equal(await sendRawRequest(`${origin}/api/search`, {
      headers: { ...headers, "Transfer-Encoding": "chunked" }, body,
    }), 413);
    assert.equal(providerCalls, 0);
  });
});

test("throttles failed authentication, ignores spoofed forwarding headers, and recovers", async () => {
  let currentTime = 1000;
  await withServer({
    requireAuth: true, authUser: "owner", authPassword: "test-password",
    authAttemptLimit: 2, now: () => currentTime,
  }, async (origin) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(origin, {
        headers: { "X-Forwarded-For": `192.0.2.${attempt}` },
      });
      assert.equal(response.status, 401);
    }
    const blocked = await fetch(origin, { headers: { "X-Forwarded-For": "192.0.2.99" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    // Do not check any further guesses while the failure bucket is exhausted.
    const authorization = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
    assert.equal((await fetch(origin, { headers: { Authorization: authorization } })).status, 429);
    currentTime += 60_000;
    assert.equal((await fetch(origin, { headers: { Authorization: authorization } })).status, 200);
    assert.equal((await fetch(origin)).status, 401);
  });
});

test("caps total provider requests independently of the per-client limit", async () => {
  let currentTime = 1000;
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token", globalRateLimit: 1, rateLimit: 100,
    now: () => currentTime,
    fetchImpl: async () => { providerCalls += 1; return Response.json({ web: { results: [] } }); },
  }, async (origin) => {
    const submit = () => fetch(`${origin}/api/search`, {
      method: "POST", headers: searchHeaders(origin), body: JSON.stringify({ query: "test" }),
    });
    assert.equal((await submit()).status, 200);
    const blocked = await submit();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    assert.equal(providerCalls, 1);
    currentTime += 60_000;
    assert.equal((await submit()).status, 200);
    assert.equal(providerCalls, 2);
  });
});

test("bounds concurrent provider work and releases slots after a failure", async () => {
  let release;
  let started;
  let providerCalls = 0;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  await withServer({
    apiKey: "test-token", maxConcurrentSearches: 1,
    fetchImpl: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        started();
        await new Promise((resolve) => { release = resolve; });
        throw new Error("private provider failure");
      }
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const submit = () => fetch(`${origin}/api/search`, {
      method: "POST", headers: searchHeaders(origin), body: JSON.stringify({ query: "test" }),
    });
    const pending = submit();
    await providerStarted;
    try {
      const busy = await submit();
      assert.equal(busy.status, 503);
      assert.equal(providerCalls, 1);
    } finally {
      release();
    }
    assert.equal((await pending).status, 502);
    assert.equal((await submit()).status, 200);
    assert.equal(providerCalls, 2);
  });
});

test("requires authentication by default in production and rejects unsafe limits", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => createServer(), /credentials are not configured/);
    assert.throws(() => createServer({ requireAuth: false }), /authentication/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  for (const key of ["rateLimit", "globalRateLimit", "authAttemptLimit", "maxConcurrentSearches"]) {
    for (const value of [0, -1, 1.5, Infinity, "20"]) {
      assert.throws(() => createServer({ [key]: value }), /positive integer/);
    }
  }
});

test("refuses to start an unauthenticated listener beyond loopback", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: {
      ...process.env, NODE_ENV: "test", HORIZON_HOST: "0.0.0.0", PORT: "3000",
      HORIZON_REQUIRE_AUTH: "false", HORIZON_ENABLE_HSTS: "false",
      HORIZON_BASIC_AUTH_USER: "", HORIZON_BASIC_AUTH_PASSWORD: "", BRAVE_SEARCH_API_KEY: "",
      HORIZON_ALLOWED_ORIGIN: "", HORIZON_SEARCH_RATE_LIMIT: "20",
      HORIZON_GLOBAL_RATE_LIMIT: "60", HORIZON_AUTH_ATTEMPT_LIMIT: "10",
      HORIZON_MAX_CONCURRENT_SEARCHES: "4",
    },
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Binding beyond loopback requires authentication credentials/);
});

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

function searchHeaders(origin, authorization) {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

function sendRawRequest(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("requires valid credentials for the private deployment", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    requireAuth: true,
    authUser: "owner",
    authPassword: "test-password",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    for (const path of ["/", "/results", "/terms", "/privacy"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate"), /^Basic realm=/);
    }

    const unauthorizedSearch = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query: "private query" }),
    });
    assert.equal(unauthorizedSearch.status, 401);
    assert.equal(providerCalls, 0);

    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");

    const authorization = `Basic ${Buffer.from("owner:test-password").toString("base64")}`;
    const home = await fetch(origin, { headers: { Authorization: authorization } });
    assert.equal(home.status, 200);
    const search = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin, authorization),
      body: JSON.stringify({ query: "private query" }),
    });
    assert.equal(search.status, 200);
    assert.equal(providerCalls, 1);
  });
});

test("fails closed when required authentication credentials are incomplete", () => {
  assert.throws(
    () => createServer({ requireAuth: true }),
    /credentials are not configured/,
  );
  assert.throws(
    () => createServer({ authUser: "owner", authPassword: "" }),
    /must both be set/,
  );
  assert.throws(
    () => createServer({ authUser: "owner:name", authPassword: "test-password" }),
    /must not contain a colon/,
  );
});

test("rejects malformed and incorrect credentials on static and API routes", async () => {
  let providerCalls = 0;
  await withServer({
    requireAuth: true, authUser: "owner", authPassword: "test-password", apiKey: "secret-sentinel",
    fetchImpl: async () => { providerCalls += 1; throw new Error("secret-sentinel"); },
  }, async (origin) => {
    for (const authorization of [
      "Bearer test-password", "Basic !!!", "Basic b3duZXI=",
      `Basic ${Buffer.from("owner:wrong-password").toString("base64")}`,
    ]) {
      const asset = await fetch(`${origin}/results.js`, { headers: { Authorization: authorization } });
      assert.equal(asset.status, 401);
      assert.doesNotMatch(await asset.text(), /secret-sentinel/);
      const api = await fetch(`${origin}/api/search`, {
        method: "POST", headers: searchHeaders(origin, authorization),
        body: JSON.stringify({ query: "test", id: "another-owner" }),
      });
      assert.equal(api.status, 401);
    }
    assert.equal(providerCalls, 0);
  });
});

test("applies security headers and never serves alternate secret files", async () => {
  await withServer({ enableHsts: true }, async (origin) => {
    for (const path of ["/", "/results.js", "/healthz", "/.env.production", "/.env.local", "/.git/config"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, path.startsWith("/.") ? 404 : 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.doesNotMatch(response.headers.get("content-security-policy"), /img-src[^;]*data:/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
      assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(response.headers.get("origin-agent-cluster"), "?1");
      assert.equal(response.headers.get("x-dns-prefetch-control"), "off");
      assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
      await response.text();
    }
  });
});

test("enables HSTS only when configured for an HTTPS deployment", async () => {
  await withServer({ enableHsts: true }, async (origin) => {
    const response = await fetch(origin);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
    );
  });

  await withServer({ enableHsts: false }, async (origin) => {
    const response = await fetch(origin);
    assert.equal(response.headers.get("strict-transport-security"), null);
  });
});

test("forces HSTS in production and rejects unsafe authentication values", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withServer({
      authUser: "owner", authPassword: "test-password", enableHsts: false,
    }, async (origin) => {
      const response = await fetch(origin, {
        headers: { Authorization: `Basic ${Buffer.from("owner:test-password").toString("base64")}` },
      });
      assert.equal(
        response.headers.get("strict-transport-security"),
        "max-age=31536000; includeSubDomains",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }

  for (const value of ["x\u0000y", "x".repeat(257)]) {
    assert.throws(
      () => createServer({ authUser: "owner", authPassword: value }),
      /must be at most 256 characters without control characters/,
    );
  }
});

test("serves the search page without making provider requests", async () => {
  let providerCalls = 0;
  await withServer({
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("unexpected provider call");
    },
  }, async (origin) => {
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Your query is sent to Brave Search/);
    assert.match(page, /Submit a query to search Brave/);
    assert.equal(providerCalls, 0);
  });
});

test("serves a separate results page and its client script", async () => {
  await withServer({}, async (origin) => {
    const page = await fetch(`${origin}/results`);
    const script = await fetch(`${origin}/results.js`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Search categories/);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /Google Maps/);
  });
});

test("does not serve environment or server files as static assets", async () => {
  await withServer({}, async (origin) => {
    for (const path of ["/.env", "/.env.example", "/src/server.mjs", "/package.json"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 404, `${path} should not be public`);
    }
  });
});

test("serves terms, privacy notice, and the supplied logo", async () => {
  await withServer({}, async (origin) => {
    const terms = await fetch(`${origin}/terms`);
    const privacy = await fetch(`${origin}/privacy`);
    const logo = await fetch(`${origin}/horizon-logo.svg`);
    assert.equal(terms.status, 200);
    const termsContent = await terms.text();
    assert.match(termsContent, /Terms &amp; Conditions/);
    assert.match(termsContent, /Draft for review/);
    assert.match(termsContent, /the query is sent[\s\S]*to Brave Search/);
    assert.match(termsContent, /Teja Thuppeda/);
    assert.match(termsContent, /personal,[\s\S]*non-commercial use only/);
    assert.match(termsContent, /laws of India/);
    assert.match(termsContent, /Maharashtra, India/);
    assert.match(termsContent, /tejatuppada82@gmail\.com/);
    assert.equal(privacy.status, 200);
    const privacyContent = await privacy.text();
    assert.match(privacyContent, /Draft for review/);
    assert.match(privacyContent, /query[\s\S]*browser history/);
    assert.match(privacyContent, /hosting provider has not yet been selected/);
    assert.match(privacyContent, /tejatuppada82@gmail\.com/);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await logo.text(), /HORIZON/);
  });
});

test("reports missing API configuration without calling Brave", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "",
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("unexpected provider call");
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query: "test search" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /BRAVE_SEARCH_API_KEY/);
    assert.equal(providerCalls, 0);
  });
});

test("validates queries and limits provider calls per client", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    rateLimit: 1,
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const submit = (query) => fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query }),
    });

    assert.equal((await submit("   ")).status, 400);
    assert.equal((await submit("  valid   query  ")).status, 200);
    const limited = await submit("another query");
    assert.equal(limited.status, 429);
    assert.equal(providerCalls, 1);
  });
});

test("rejects invalid pagination input without calling Brave", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    for (const page of [0, 11, 1.5, "2"]) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST",
        headers: searchHeaders(origin),
        body: JSON.stringify({ query: "test", page }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(providerCalls, 0);
  });
});

test("validates result categories and routes Brave categories", async () => {
  const providerUrls = [];
  await withServer({
    apiKey: "test-token",
    fetchImpl: async (url) => {
      providerUrls.push(url);
      return Response.json({ web: { results: [] }, results: [] });
    },
  }, async (origin) => {
    for (const type of ["all", "images", "videos", "news"]) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST",
        headers: searchHeaders(origin),
        body: JSON.stringify({ query: "test", type }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).type, type);
    }

    for (const type of ["maps", "shopping", "__proto__", "unsupported"]) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST",
        headers: searchHeaders(origin),
        body: JSON.stringify({ query: "test", type }),
      });
      assert.equal(response.status, 400);
    }

    assert.deepEqual(providerUrls.map((url) => url.pathname), [
      "/res/v1/web/search",
      "/res/v1/images/search",
      "/res/v1/videos/search",
      "/res/v1/news/search",
    ]);
  });
});

test("accepts paginated image, video, and news requests", async () => {
  const providerUrls = [];
  await withServer({
    apiKey: "test-token",
    fetchImpl: async (url) => {
      providerUrls.push(url);
      return Response.json({
        results: Array.from({ length: 20 }, (_, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.com/${index + 1}`,
        })),
      });
    },
  }, async (origin) => {
    for (const type of ["images", "videos", "news"]) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST",
        headers: searchHeaders(origin),
        body: JSON.stringify({ query: "test", type, page: 2 }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.page, 2);
      assert.equal(payload.hasNext, true);
    }

    const imagePage21 = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query: "test", type: "images", page: 21 }),
    });
    const videoPage11 = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query: "test", type: "videos", page: 11 }),
    });
    assert.equal(imagePage21.status, 400);
    assert.equal(videoPage11.status, 400);
    assert.deepEqual(providerUrls.map((url) => url.searchParams.get("offset")), [
      null,
      "1",
      "1",
    ]);
  });
});

test("expires client rate limits after one minute", async () => {
  let currentTime = 1000;
  await withServer({
    apiKey: "test-token",
    now: () => currentTime,
    rateLimit: 1,
    fetchImpl: async () => Response.json({ web: { results: [] } }),
  }, async (origin) => {
    const submit = () => fetch(`${origin}/api/search`, {
      method: "POST",
      headers: searchHeaders(origin),
      body: JSON.stringify({ query: "test" }),
    });

    assert.equal((await submit()).status, 200);
    assert.equal((await submit()).status, 429);
    currentTime += 60_000;
    assert.equal((await submit()).status, 200);
  });
});

test("rejects cross-origin, originless, and non-JSON search requests", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const body = JSON.stringify({ query: "test" });
    const requests = [
      {
        headers: {
          ...searchHeaders(origin),
          Origin: "https://attacker.invalid",
          "Sec-Fetch-Site": "cross-site",
        },
        expectedStatus: 403,
      },
      {
        headers: { "Content-Type": "application/json" },
        expectedStatus: 403,
      },
      {
        headers: {
          ...searchHeaders(origin),
          "Sec-Fetch-Site": "cross-site",
        },
        expectedStatus: 403,
      },
      {
        headers: {
          ...searchHeaders("http://attacker.invalid"),
        },
        expectedStatus: 403,
        host: "attacker.invalid",
      },
      {
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "text/plain",
        },
        expectedStatus: 415,
      },
    ];

    for (const { headers, expectedStatus, host } of requests) {
      const response = await fetch(`${origin}/api/search`, {
        method: "POST",
        headers: host ? { ...headers, Host: host } : headers,
        body,
      });
      assert.equal(response.status, expectedStatus);
    }
    assert.equal(providerCalls, 0);
  });
});

test("allows an explicitly configured Render origin", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    allowedOrigin: "https://horizon-search.onrender.com",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://horizon-search.onrender.com",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ query: "test" }),
    });
    assert.equal(response.status, 200);
    assert.equal(providerCalls, 1);
  });
});

test("rejects HTTPS search requests with a host that does not match the server", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/search`, {
      method: "POST",
      headers: {
        ...searchHeaders("https://horizon-search.onrender.com"),
      },
      body: JSON.stringify({ query: "test" }),
    });
    assert.equal(response.status, 403);
    assert.equal(providerCalls, 0);
  });
});

test("accepts HTTPS same-origin search requests for the Render service host", async () => {
  let providerCalls = 0;
  await withServer({
    apiKey: "test-token",
    fetchImpl: async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    },
  }, async (origin) => {
    const body = JSON.stringify({ query: "test" });
    const status = await sendRawRequest(`${origin}/api/search`, {
      headers: {
        Host: "horizon-search.onrender.com",
        Origin: "https://horizon-search.onrender.com",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body,
    });
    assert.equal(status, 200);
    assert.equal(providerCalls, 1);
  });
});
