const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_SEARCH_PAGES = 10;
export const MAX_IMAGE_PAGES = 20;
export const SEARCH_TYPES = ["all", "images", "videos", "news"];
const RESULTS_PER_PAGE = 10;
const SEARCH_ENDPOINTS = {
  all: `${BRAVE_ENDPOINT}`,
  images: "https://api.search.brave.com/res/v1/images/search",
  videos: "https://api.search.brave.com/res/v1/videos/search",
  news: "https://api.search.brave.com/res/v1/news/search",
};

export class SearchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SearchError";
    this.status = status;
  }
}

export function normalizeQuery(value) {
  // Validate before normalization so excessive whitespace cannot bypass the limit.
  if (
    typeof value !== "string" || value.length > 400 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new SearchError("Enter a query between 1 and 400 characters without control characters.", 400);
  }
  const query = value.trim().replace(/\s+/g, " ");
  if (!query) throw new SearchError("Enter a query between 1 and 400 characters.", 400);
  return query;
}

function safeResultUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;

  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function boundedText(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeResults(payload, page, type) {
  const results = type === "all"
    ? payload?.web?.results
    : payload?.[type]?.results ?? payload?.results;
  if (!Array.isArray(results)) {
    throw new SearchError("Brave returned an unexpected response.", 502);
  }

  return {
    results: results
      .slice(type === "images" ? (page - 1) * RESULTS_PER_PAGE : 0, page * RESULTS_PER_PAGE)
      .flatMap((result) => {
        const url = safeResultUrl(result?.url);
        if (!url) return [];
        const thumbnail = safeResultUrl(
          result?.thumbnail?.src ?? result?.thumbnail ?? result?.properties?.url,
        );

        return [{
          title: boundedText(result.title, 300) || url.hostname,
          url: url.href,
          hostname: url.hostname,
          breadcrumb: url.pathname.split("/").filter(Boolean).slice(0, 3).join(" › "),
          description: boundedText(result.description, 800),
          imageUrl: thumbnail?.protocol === "https:" ? thumbnail.href : "",
        }];
      }),
    hasNext: page < (type === "images" ? MAX_IMAGE_PAGES : MAX_SEARCH_PAGES) &&
      results.length >= (type === "images" ? page * RESULTS_PER_PAGE : RESULTS_PER_PAGE),
  };
}

async function readJsonBounded(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SearchError("Brave returned an oversized response.", 502);
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new SearchError("Brave returned an oversized response.", 502);
    }
    return JSON.parse(text);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SearchError("Brave returned an oversized response.", 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function searchBrave(query, apiKey, fetchImpl = fetch, page = 1, type = "all") {
  query = normalizeQuery(query);
  if (!SEARCH_TYPES.includes(type)) {
    throw new SearchError("Choose a supported search category.", 400);
  }
  const maxPages = type === "images" ? MAX_IMAGE_PAGES : MAX_SEARCH_PAGES;
  if (!Number.isInteger(page) || page < 1 || page > maxPages) {
    throw new SearchError("Choose a valid results page.", 400);
  }

  const url = new URL(SEARCH_ENDPOINTS[type]);
  url.searchParams.set("q", query);
  url.searchParams.set(
    "count",
    String(type === "images" ? page * RESULTS_PER_PAGE : RESULTS_PER_PAGE),
  );
  if (type !== "images") url.searchParams.set("offset", String(page - 1));

  let response;
  try {
    response = await fetchImpl(url, {
      // Never forward the provider token to a redirected destination.
      redirect: "error",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new SearchError("Search timed out. Please try again.", 504);
    }
    throw new SearchError("Brave Search is temporarily unavailable.", 502);
  }

  if (response.status === 401 || response.status === 403) {
    throw new SearchError("Brave Search is not configured correctly.", 503);
  }
  if (response.status === 429) {
    throw new SearchError("Brave Search is busy. Please try again later.", 429);
  }
  if (response.status >= 500) {
    throw new SearchError("Brave Search is temporarily unavailable.", 503);
  }
  if (!response.ok) {
    throw new SearchError("Brave could not complete this search.", 502);
  }

  try {
    return normalizeResults(await readJsonBounded(response), page, type);
  } catch (error) {
    if (error instanceof SearchError) throw error;
    throw new SearchError("Brave returned an invalid response.", 502);
  }
}
