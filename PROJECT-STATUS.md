# Horizon Search — Project status

**Last updated:** 2026-10-29
**Current phase:** Published on Render as a private, Basic Auth-protected service

## Done

- Created this project in `C:\Horizon Search_VSC`.
- Added a responsive search page and a Node.js server using built-in modules.
- Added a server-side Brave Search adapter, result normalization, safe HTTP(S)
  URL checks, request timeout, and per-client rate limiting.
- Added an explicit disclosure that a submitted query is sent to Brave.
- Kept autocomplete, analytics, caching, and all other background requests out
  of this initial version.
- Added mocked tests; ordinary checks do not contact Brave.
- Verified all nine tests pass and the search form fits a 390px mobile viewport.
- Added the Brave key to the local, Git-ignored `.env`; `.env.example` stays
  blank and contains no secret.
- Loaded the owner's API key from `.env` on the server. It is not included in
  the browser assets or served files.
- Restarted the local app at `http://localhost:3000`; verified the homepage
  and JavaScript asset return 200 while `.env`, server source, and package
  metadata return 404.
- Verified Node loads the key and that its value is absent from public
  homepage and JavaScript responses. No Brave search was sent during setup.
- Added the supplied Horizon logo, a Terms & Conditions page, footer credit,
  orange accents, pill-shaped search controls, and result pagination.
- Replaced the supplied logo with the newer `gemini-svg (1).svg` artwork and
  verified the running app serves that exact SVG.
- Verified mocked pagination requests pages 1 and 2, the logo loads, footer
  links and credit display, the terms page opens, and controls remain pill
  shaped at a 390px viewport.
- Added same-origin, JSON-only, Fetch Metadata, and loopback-host checks to
  prevent cross-site pages and DNS-rebinding hosts from triggering billable
  searches through the local server.
- Kept the executable server loopback-only, configured request/header
  timeouts, and documented that public deployment needs independent abuse
  controls.
- Security review confirmed and fixed a cross-origin billable-search/CSRF
  route. No exploitable XSS, prototype pollution, SSRF, or forwarded-header
  rate-limit bypass was confirmed in the reviewed paths.
- All 19 automated tests pass after the UI, category, and security changes.
- Kept the home page unchanged and moved query results to a separate `/results`
  page with All, Images, Videos, Maps, Shopping, and News categories.
- Routed All, Images, Videos, and News to their corresponding Brave API
  endpoints. Maps and Shopping provide user-clicked Google destinations
  because those are not implemented as Brave-backed categories here.
- Added category pagination: Videos and News use Brave offsets (up to 10 pages);
  Images uses the documented count limit to provide 20 pages of 10 without
  sending an unsupported offset parameter.
- Verified category page 2 requests in mocked provider tests: Videos and News
  send offset 1; Images requests 20 results and displays items 11–20. Image
  requests stop at the documented 200-result cap.
- All 23 automated tests pass after category pagination changes.
- Updated the Terms & Conditions using the supplied public-search-engine PDF,
  tailoring provider disclosures and acceptable-use terms to Horizon Search.
- Added the owner-provided operator name, contact email, India/Maharashtra
  governing-law and venue language, and personal non-commercial use restriction.
- Added a separately linked Privacy Notice covering query/referrer behavior,
  Brave/Google interactions, temporary in-memory IP rate limiting, and known
  application storage behavior.
- Kept both legal pages marked as drafts because hosting-provider log practices
  and launch-specific legal requirements remain unconfirmed; qualified legal
  review is still needed before public launch.
- All 23 automated tests pass after adding and routing both legal pages.
- Added Render Blueprint configuration, Node version pin/range, `PORT`-aware
  binding, and a health-check endpoint.
- Added application-wide Basic Auth for the Render deployment. The Blueprint
  requires credentials and the server fails closed if they are missing;
  local development remains unauthenticated by default.
- Added automated checks for protected routes, valid/invalid authentication,
  Render-host same-origin requests, and the unauthenticated health check.
- All 27 automated tests pass after the Render deployment changes.
- Published the Render service at
  `https://horizon-search-h0r3.onrender.com/`; an unauthenticated request
  returned HTTP 401, consistent with the configured Basic Auth protection.
- Updated the GitHub README with the published URL, private-access note,
  Free-plan wake-up behavior, and custom browser search URL template.
- Reviewed the reported IDOR, SQL injection, query validation, authentication,
  secret storage, XSS, dependency, and transport-security concerns against the
  project. No IDOR or SQL/database surface exists; the relevant query,
  authentication, secret, and output-safety controls are already implemented.
- Enabled configurable HSTS for Render's HTTPS deployment and added tests;
  HSTS remains disabled by default for local HTTP development.
- Hardened search JSON schema and shared query validation, including raw query
  length and control-character checks; undeclared `id`/`name` fields are rejected.
- Added failed-login throttling before credential checks, global-per-process
  search admission, bounded limiter storage, and concurrent-provider limits.
- Required credentials for production mode and external-address startup;
  expanded ignored environment variants and explicitly enabled production in
  the Render Blueprint. Added Permissions-Policy and disabled provider redirects.
- Added `SECURITY.md` with the finding-by-finding disposition, scope, verified
  controls, and remaining deployment responsibilities. No database or ID-based
  object endpoint was found; no ORM or multi-user login framework was added.
- All 40 mocked automated tests pass after security hardening, including
  malicious result rendering, access checks, input limits, throttling/recovery,
  provider quotas/concurrency, and unauthenticated external-listener rejection.

## Waiting on the project owner

- Sign in to the hosted service and confirm that authenticated searches work;
  this requires a live Brave API request and uses the configured Brave quota.
- Confirm Brave plan limits and spending/budget alerts.
- Review the Terms & Conditions and Privacy Notice with qualified counsel.
  Confirm Render's and Brave's applicable data-handling and retention details.
- The hosted service is intentionally private. Before making it public, choose
  an appropriate authentication model and add deployment-wide abuse controls,
  global quotas, and provider budget alerts.

## Next

1. Verify the hosted search flow using the Render Basic Auth credentials.
2. Confirm Brave plan limits and budget, and review the legal pages before
   promoting the service beyond private owner use.
3. If desired, configure Horizon as a browser search provider where supported;
   verify Basic Auth works with that browser's address-bar search flow.

This status file is the project progress log and will be updated as work
continues.
