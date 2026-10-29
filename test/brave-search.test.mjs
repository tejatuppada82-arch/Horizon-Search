import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_PAGES,
  searchBrave,
  SearchError,
  SEARCH_TYPES,
} from "../src/brave-search.mjs";

test("sends the query with the server token and normalizes safe results", async () => {
  let requestUrl;
  let requestOptions;
  const fetchImpl = async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return Response.json({
      web: {
        results: [
          {
            title: "Useful result",
            url: "https://example.com/guides/search?q=tracking",
            description: "A useful description.",
          },
          { title: "Unsafe", url: "javascript:alert(1)" },
          { title: "Credential URL", url: "https://user:pass@example.com/" },
        ],
      },
    });
  };

  const results = await searchBrave("sample query", "server-secret", fetchImpl);

  assert.equal(requestUrl.searchParams.get("q"), "sample query");
  assert.equal(requestUrl.searchParams.get("count"), "10");
  assert.equal(requestUrl.searchParams.get("offset"), "0");
  assert.equal(requestOptions.headers["X-Subscription-Token"], "server-secret");
  assert.equal(results.results.length, 1);
  assert.equal(results.hasNext, false);
  assert.deepEqual(results.results[0], {
    title: "Useful result",
    url: "https://example.com/guides/search?q=tracking",
    hostname: "example.com",
    breadcrumb: "guides › search",
    description: "A useful description.",
    imageUrl: "",
  });
});

test("requests the selected Brave results page", async () => {
  let requestUrl;
  const results = await searchBrave("sample query", "server-secret", async (url) => {
    requestUrl = url;
    return Response.json({
      web: { results: Array.from({ length: 10 }, (_, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example.com/${index + 1}`,
      })) },
    });
  }, 4);

  assert.equal(requestUrl.searchParams.get("offset"), "3");
  assert.equal(results.results.length, 10);
  assert.equal(results.hasNext, true);
});

test("uses Brave's image, video, and news endpoints", async () => {
  const expectedPaths = {
    images: "/res/v1/images/search",
    videos: "/res/v1/videos/search",
    news: "/res/v1/news/search",
  };
  for (const type of ["images", "videos", "news"]) {
    let requestUrl;
    const results = await searchBrave("category query", "server-secret", async (url) => {
      requestUrl = url;
      return Response.json({
        results: [{
          title: `${type} result`,
          url: "https://example.com/story",
          description: "Category result",
          thumbnail: { src: "https://imgs.search.brave.com/preview" },
        }],
      });
    }, 1, type);

    assert.equal(requestUrl.pathname, expectedPaths[type]);
    assert.equal(requestUrl.searchParams.get("q"), "category query");
    if (type === "images") {
      assert.equal(requestUrl.searchParams.has("offset"), false);
    } else {
      assert.equal(requestUrl.searchParams.get("offset"), "0");
    }
    assert.equal(results.results[0].title, `${type} result`);
    assert.equal(results.results[0].imageUrl, "https://imgs.search.brave.com/preview");
    assert.equal(results.hasNext, false);
  }
});

test("paginates image results by requesting a larger bounded count", async () => {
  let requestUrl;
  const results = await searchBrave("category query", "server-secret", async (url) => {
    requestUrl = url;
    return Response.json({
      results: Array.from({ length: 20 }, (_, index) => ({
        title: `Image ${index + 1}`,
        url: `https://example.com/image/${index + 1}`,
      })),
    });
  }, 2, "images");

  assert.equal(requestUrl.searchParams.get("count"), "20");
  assert.equal(requestUrl.searchParams.has("offset"), false);
  assert.equal(results.results.length, 10);
  assert.equal(results.results[0].title, "Image 11");
  assert.equal(results.results[9].title, "Image 20");
  assert.equal(results.hasNext, true);
});

test("paginates video and news results with Brave page offsets", async () => {
  for (const type of ["videos", "news"]) {
    let requestUrl;
    const results = await searchBrave("category query", "server-secret", async (url) => {
      requestUrl = url;
      return Response.json({
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `${type} ${index + 1}`,
          url: `https://example.com/${type}/${index + 1}`,
        })),
      });
    }, 3, type);

    assert.equal(requestUrl.searchParams.get("offset"), "2");
    assert.equal(requestUrl.searchParams.get("count"), "10");
    assert.equal(results.results.length, 10);
    assert.equal(results.hasNext, true);
  }
});

test("caps image pagination at Brave's documented 200 result count", async () => {
  let providerCalls = 0;
  await assert.rejects(
    searchBrave("query", "server-secret", async () => {
      providerCalls += 1;
      return Response.json({ results: [] });
    }, MAX_IMAGE_PAGES + 1, "images"),
    { status: 400, message: "Choose a valid results page." },
  );
  assert.equal(providerCalls, 0);
});

test("exports only Brave-backed categories", () => {
  assert.deepEqual(SEARCH_TYPES, ["all", "images", "videos", "news"]);
});

test("rejects unsupported result pages before contacting Brave", async () => {
  let providerCalls = 0;
  await assert.rejects(
    searchBrave("query", "server-secret", async () => {
      providerCalls += 1;
      return Response.json({ web: { results: [] } });
    }, 11),
    { status: 400, message: "Choose a valid results page." },
  );
  assert.equal(providerCalls, 0);
});

test("maps provider quota errors without exposing its response", async () => {
  await assert.rejects(
    searchBrave("query", "server-secret", async () =>
      new Response("private provider details", { status: 429 }),
    ),
    (error) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.status, 429);
      assert.doesNotMatch(error.message, /private provider details/);
      return true;
    },
  );
});

test("fails closed on a malformed provider response", async () => {
  await assert.rejects(
    searchBrave("query", "server-secret", async () =>
      new Response("{not json}", { status: 200 }),
    ),
    { status: 502, message: "Brave returned an invalid response." },
  );
});

test("validates queries at the provider boundary without stripping legitimate search syntax", async () => {
  let providerCalls = 0;
  const fetchImpl = async (url, options) => {
    providerCalls += 1;
    assert.equal(url.searchParams.get("q"), `' OR 1=1;-- <script>alert(1)</script> site:example.com`);
    assert.equal(options.redirect, "error");
    return Response.json({ web: { results: [] } });
  };
  for (const query of [null, {}, [], 1, "", " ", "x".repeat(401), "x\u0000y"]) {
    await assert.rejects(searchBrave(query, "test-token", fetchImpl), { status: 400 });
  }
  assert.equal(providerCalls, 0);
  await searchBrave(`' OR 1=1;-- <script>alert(1)</script> site:example.com`, "test-token", fetchImpl);
  assert.equal(providerCalls, 1);
});

test("rejects oversized declared and streamed provider bodies", async () => {
  for (const response of [
    new Response("{}", { headers: { "Content-Length": "1000001" } }),
    new Response("x".repeat(1_000_001)),
  ]) {
    await assert.rejects(searchBrave("test", "test-token", async () => response), {
      status: 502, message: "Brave returned an oversized response.",
    });
    assert.equal(response.body.locked, false);
  }
});
