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

## Current milestone

See [PROJECT-STATUS.md](./PROJECT-STATUS.md) for what is implemented and what
is waiting on the project owner.
