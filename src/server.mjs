import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MAX_IMAGE_PAGES,
  MAX_SEARCH_PAGES,
  SEARCH_TYPES,
  searchBrave,
  SearchError,
} from "./brave-search.mjs";

const ROOT = new URL("../", import.meta.url);
const MAX_REQUEST_BYTES = 4096;
const RATE_WINDOW_MS = 60_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://imgs.search.brave.com",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

function sendJson(response, status, body) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function parseBoolean(value, name) {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false".`);
}

function credentialsMatch(request, username, password) {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" &&
    authorization.length <= 1024 &&
    /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return false;

  const encodedCredentials = match[1];
  const credentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
  if (Buffer.from(credentials, "utf8").toString("base64") !== encodedCredentials) {
    return false;
  }
  const separator = credentials.indexOf(":");
  if (separator < 0) return false;

  const suppliedUsername = Buffer.from(credentials.slice(0, separator), "utf8");
  const suppliedPassword = Buffer.from(credentials.slice(separator + 1), "utf8");
  const expectedUsername = Buffer.from(username, "utf8");
  const expectedPassword = Buffer.from(password, "utf8");
  return suppliedUsername.length === expectedUsername.length &&
    suppliedPassword.length === expectedPassword.length &&
    timingSafeEqual(suppliedUsername, expectedUsername) &&
    timingSafeEqual(suppliedPassword, expectedPassword);
}

function requireAuthentication(request, response, username, password) {
  if (credentialsMatch(request, username, password)) return true;
  response.setHeader("WWW-Authenticate", 'Basic realm="Horizon Search", charset="UTF-8"');
  sendJson(response, 401, { error: "Authentication required." });
  return false;
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError("Request is too large.", 413);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError("Request is too large.", 413);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("Send a valid JSON search request.", 400);
  }
}

function validateSearchRequest(request, allowedOrigin) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError("Search requests must use application/json.", 415);
  }

  const origin = request.headers.origin;
  if (!origin || request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError("Search requests must come from this site.", 403);
  }

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError("Search requests must come from this site.", 403);
  }
  if (originUrl.origin !== origin || !["http:", "https:"].includes(originUrl.protocol)) {
    throw new HttpError("Search requests must come from this site.", 403);
  }

  if (allowedOrigin) {
    if (originUrl.origin !== new URL(allowedOrigin).origin) {
      throw new HttpError("Search requests must come from this site.", 403);
    }
    return;
  }

  let hostUrl;
  try {
    hostUrl = new URL(`http://${request.headers.host}`);
  } catch {
    throw new HttpError("Search requests must come from this site.", 403);
  }
  if (
    originUrl.host !== hostUrl.host ||
    (LOOPBACK_HOSTS.has(hostUrl.hostname)
      ? originUrl.protocol !== "http:"
      : originUrl.protocol !== "https:")
  ) {
    throw new HttpError("Search requests must come from this site.", 403);
  }
}

function normalizeAllowedOrigin(value) {
  if (!value) return undefined;

  const origin = new URL(value);
  if (
    origin.origin !== value ||
    !["http:", "https:"].includes(origin.protocol)
  ) {
    throw new Error("HORIZON_ALLOWED_ORIGIN must be an exact HTTP(S) origin.");
  }
  return origin.origin;
}

function makeRateLimiter(limit, now) {
  const clients = new Map();
  let lastPrunedAt = 0;

  return (key) => {
    const currentTime = now();
    if (currentTime - lastPrunedAt >= RATE_WINDOW_MS) {
      for (const [client, record] of clients) {
        if (currentTime - record.startedAt >= RATE_WINDOW_MS) clients.delete(client);
      }
      lastPrunedAt = currentTime;
    }

    let client = clients.get(key);
    if (!client || currentTime - client.startedAt >= RATE_WINDOW_MS) {
      client = { startedAt: currentTime, count: 0 };
      clients.set(key, client);
    }

    if (client.count >= limit) return false;
    client.count += 1;
    return true;
  };
}

async function serveStatic(pathname, response) {
  const files = {
    "/": ["public/index.html", "text/html; charset=utf-8"],
    "/results": ["public/results.html", "text/html; charset=utf-8"],
    "/terms": ["public/terms.html", "text/html; charset=utf-8"],
    "/privacy": ["public/privacy.html", "text/html; charset=utf-8"],
    "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
    "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
    "/results.js": ["public/results.js", "text/javascript; charset=utf-8"],
    "/horizon-logo.svg": ["public/horizon-logo.svg", "image/svg+xml; charset=utf-8"],
  };
  const file = files[pathname];
  if (!file) return false;

  const contents = await readFile(new URL(file[0], ROOT));
  send(response, 200, file[1], contents);
  return true;
}

export function createServer({
  apiKey = process.env.BRAVE_SEARCH_API_KEY,
  allowedOrigin: configuredOrigin = process.env.HORIZON_ALLOWED_ORIGIN,
  requireAuth = parseBoolean(process.env.HORIZON_REQUIRE_AUTH, "HORIZON_REQUIRE_AUTH"),
  enableHsts = parseBoolean(process.env.HORIZON_ENABLE_HSTS, "HORIZON_ENABLE_HSTS"),
  authUser = process.env.HORIZON_BASIC_AUTH_USER,
  authPassword = process.env.HORIZON_BASIC_AUTH_PASSWORD,
  fetchImpl = fetch,
  now = Date.now,
  rateLimit = 20,
} = {}) {
  const allowedOrigin = normalizeAllowedOrigin(configuredOrigin);
  const authEnabled = Boolean(authUser || authPassword);
  if (authEnabled && (!authUser || !authPassword)) {
    throw new Error("HORIZON_BASIC_AUTH_USER and HORIZON_BASIC_AUTH_PASSWORD must both be set.");
  }
  if (requireAuth && !authEnabled) {
    throw new Error("Basic authentication is required but its credentials are not configured.");
  }
  if (authUser?.includes(":")) {
    throw new Error("HORIZON_BASIC_AUTH_USER must not contain a colon.");
  }
  const allowSearch = makeRateLimiter(rateLimit, now);

  return createHttpServer(async (request, response) => {
    if (enableHsts) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        send(response, 200, "text/plain; charset=utf-8", "ok");
        return;
      }
      if (
        authEnabled &&
        !requireAuthentication(request, response, authUser, authPassword)
      ) {
        return;
      }
      if (request.method === "GET" && await serveStatic(url.pathname, response)) {
        return;
      }
      if (url.pathname !== "/api/search") {
        sendJson(response, 404, { error: "Not found." });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "Use POST to submit a search." });
        return;
      }

      validateSearchRequest(request, allowedOrigin);
      const body = await readRequestBody(request);
      const query = typeof body?.query === "string"
        ? body.query.trim().replace(/\s+/g, " ")
        : "";
      if (!query || query.length > 400) {
        throw new HttpError("Enter a query between 1 and 400 characters.", 400);
      }
      const page = body?.page === undefined ? 1 : body.page;
      const type = body?.type === undefined ? "all" : body.type;
      const maxPages = type === "images" ? MAX_IMAGE_PAGES : MAX_SEARCH_PAGES;
      if (!SEARCH_TYPES.includes(type) || !Number.isInteger(page) || page < 1 || page > maxPages) {
        throw new HttpError("Choose a supported search category and page.", 400);
      }
      if (!apiKey) {
        throw new HttpError(
          "Live search is not configured yet. Add BRAVE_SEARCH_API_KEY on the server.",
          503,
        );
      }

      const client = request.socket.remoteAddress || "unknown";
      if (!allowSearch(client)) {
        throw new HttpError("Too many searches. Please wait a minute and try again.", 429);
      }

      const { results, hasNext } = await searchBrave(query, apiKey, fetchImpl, page, type);
      sendJson(response, 200, { results, provider: "Brave Search", page, type, hasNext });
    } catch (error) {
      const status = error instanceof HttpError || error instanceof SearchError
        ? error.status
        : 500;
      const message = status === 500
        ? "The search service could not complete this request."
        : error.message;
      if (status === 500) process.stderr.write("Horizon Search request failed.\n");
      if (!response.headersSent) sendJson(response, status, { error: message });
      else response.destroy();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const host = process.env.HORIZON_HOST || "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  server.listen(port, host, () => {
    process.stdout.write(`Horizon Search is listening on ${host}:${port}\n`);
  });
}
