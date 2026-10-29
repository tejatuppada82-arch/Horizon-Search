# Horizon Search

A focused search interface backed by Brave Search. Horizon does not crawl or
independently index the web.

## Use Horizon Search

The hosted search engine is available at
[https://horizon-search-h0r3.onrender.com](https://horizon-search-h0r3.onrender.com).
It is a private service: enter the Basic Auth username and password configured
for the Render service when prompted. Do not share those credentials.

The Render Free service may spin down after inactivity, so its first request
after a quiet period can take about a minute while it starts.

For browsers that support custom search URLs, use this template:

```text
https://horizon-search-h0r3.onrender.com/results?q=%s&type=all
```

The browser must support the site's Basic Auth prompt for address-bar searches
to work smoothly.

## Run locally

- Install Node.js 22.9 through 24.x.
- Run `npm start` in this folder.
- Open <http://localhost:3000>.

The homepage and server run without an API key. Live searches need
`BRAVE_SEARCH_API_KEY` set in the server environment. To use a local `.env`,
copy `.env.example` to `.env`, add the key there, and restart the server. `.env`
is ignored by Git. Never put the key in browser code or send it in chat.

Submitting a search leaves the home page intact and opens a separate results
page. Brave search requests are made only after the user submits a query or
selects another Brave-backed results category.

Search results support user-requested pagination: All, Videos, and News use
Brave's ten-page offset range; Images uses Brave's documented 200-result count
limit, shown as 20 pages of 10. Results include Brave-backed All, Images,
Videos, and News categories. Maps and Shopping are explicit links to Google
Maps and Google Shopping; the search is sent to Google only if the user follows
the link. The homepage footer links to the
[Terms & Conditions](./public/terms.html) and [Privacy Notice](./public/privacy.html).
Both are working drafts. The owner supplied operator/contact details,
India/Maharashtra jurisdiction, and a personal non-commercial use policy.
Hosting-provider practices and applicable legal requirements still need
confirmation and legal review before public launch.

## Security boundary

The local server binds to `127.0.0.1` by default and accepts search requests
only with JSON content, a matching same-origin `Origin`, and no cross-site
Fetch Metadata signal. An explicitly configured `HORIZON_ALLOWED_ORIGIN`
supports a trusted reverse proxy.

The Render Blueprint (`render.yaml`) binds to `0.0.0.0` and requires
application-wide HTTP Basic authentication before serving pages or search
requests. Set the username, password, and Brave key as secret environment
variables in Render; never commit their values. Render terminates HTTPS for
the public service and enables HSTS for the deployed HTTPS origin. The health
check at `/healthz` intentionally does not require credentials.

The Render deployment is intended for private, owner-only use. Basic Auth and
same-origin checks are not a public user-account system or a substitute for
global quotas and provider budget controls. Do not change the service to
public use without first choosing suitable authentication and abuse controls.
For Render's default URL, the server verifies HTTPS and that the request Origin
matches its host. Set `HORIZON_ALLOWED_ORIGIN` only when a custom domain or
trusted proxy requires an explicit origin.

## Render configuration

The service is managed by the [Render Blueprint](./render.yaml) and deploys
from the `main` branch. Render holds `HORIZON_BASIC_AUTH_USER`,
`HORIZON_BASIC_AUTH_PASSWORD`, and `BRAVE_SEARCH_API_KEY` as environment
secrets; never commit their values. Use a unique, strong Basic Auth password,
not the Brave API key.

The deployment binds to Render's `PORT`, requires Basic Auth, and exposes
`/healthz` for the platform health check. If using a custom domain or trusted
proxy, configure `HORIZON_ALLOWED_ORIGIN` to that exact HTTPS origin.

## Checks

Run `npm test` for provider and server tests. Tests use mocked provider
responses and do not call Brave.

### Security hardening and limits

`NODE_ENV=production` requires configured Basic Auth credentials even if
`HORIZON_REQUIRE_AUTH` is unset or false. Starting the executable server on a
non-loopback address also requires credentials. Local loopback development
continues to work without credentials. Keep externally reachable instances
behind an HTTPS-terminating proxy; the app itself serves HTTP to that proxy.

The following positive-integer environment settings bound abuse and provider
work. The Render Blueprint sets these defaults explicitly:

| Setting | Default | Scope |
|---|---|---|
| `HORIZON_SEARCH_RATE_LIMIT` | 20 | Search attempts per socket IP per minute |
| `HORIZON_GLOBAL_RATE_LIMIT` | 60 | Total admitted search attempts per process per minute |
| `HORIZON_AUTH_ATTEMPT_LIMIT` | 10 | Failed sign-ins per socket IP per minute |
| `HORIZON_MAX_CONCURRENT_SEARCHES` | 4 | Active provider calls per process |

Excess attempts receive 429 with `Retry-After`; a full concurrency pool returns
503. An exhausted failed-sign-in bucket blocks further credential checks for
the remainder of its one-minute window, including valid credentials. This
prevents continued password guessing through throttled responses; legitimate
users sharing that socket IP may need to wait for the window to expire.
Forwarded IP headers are intentionally not trusted: behind a reverse proxy,
clients may share a socket-IP bucket. An edge WAF can add IP-aware protection
using the hosting provider's trusted network information.

Limits are in memory and reset on restart. They are **not** a durable monthly
spending cap or a distributed limit across replicas. Before scaling or public
use, add shared rate/budget controls, provider-side spending alerts and edge
protection. Tune limits against the actual Brave plan.

See [SECURITY.md](./SECURITY.md) for the verified finding disposition,
regression coverage, secret handling, and operational follow-up.

## Current milestone

See [PROJECT-STATUS.md](./PROJECT-STATUS.md) for what is implemented and what
is waiting on the project owner.
