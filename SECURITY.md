# Horizon Search security review

Reviewed against the supplied finding list on 2026-10-30. This is a scoped
source review with mocked regression tests, not a penetration test of Render,
Brave, or the operator's accounts. Git history was checked for common secret
patterns.

## Findings and implementation

| Reported issue | Current code and disposition |
|---|---|
| IDOR through `id` | No object IDs, user-owned records, or object mutation endpoints exist. Authentication guards all routes except the minimal `/healthz`. Search now rejects undeclared fields, including `id`. Input validation alone would not fix IDOR: any future object endpoint must enforce ownership/role authorization on every request. |
| SQL injection through `name` | There is no database, schema, SQL query, or ORM. Search uses fixed HTTPS Brave endpoints and URLSearchParams. Do not add an ORM to a project with no database. Future database access must use bound parameters and object-level authorization. |
| Search input validation | JSON body size, query length, category, and page bounds already existed. Requests now require an object containing only `query`, `type`, and `page`; reject oversized raw queries and disallowed control characters; and share validation with the provider adapter. Quotes, Unicode, operators, and HTML-looking search terms remain valid data. Removing punctuation is not an injection defense. |
| Missing authentication | Private Render deployment already required application-wide Basic Auth and failed closed for missing credentials. Production mode and external-address startup now independently enforce credentials. Exhausted failed-sign-in buckets temporarily block all credential checks for that socket IP, preventing continued guessing through 429 responses. This remains an owner-only service, not a multi-user account system. |
| Plaintext committed secrets | The reviewed tracked configuration contains empty credential examples and environment lookups, not a confirmed active credential. `.env.local`, `.env.production`, and other `.env.*` variants are now ignored, retaining only `.env.example`. Common secret patterns were also checked across Git history. Rotate and revoke any key ever exposed; ignoring a file does not remove an existing commit. |
| XSS | Existing rendering uses textContent and safe HTTP(S) result URLs, CSP, and noopener/noreferrer links. A new regression executes the result renderer with a DOM double that rejects HTML sinks, using malicious provider titles/descriptions and script/data/file URLs. It supplements, rather than replaces, real-browser testing. |
| Provider abuse/data tampering | No persistence or write endpoint exists. New global-per-process search admission and concurrent-provider limits supplement per-IP throttling. Provider redirects fail closed so custom token headers cannot follow them; oversized declared response bodies are canceled. |

## Controls and tests

- Strict JSON object schema, query/control-character/type/page validation before
  billable requests; validation also applies to direct provider-adapter callers.
- 4 KB request-body and 1 MB provider-response limits, streaming size checks,
  8-second provider timeout, and 10-second HTTP header/request timeouts.
- Application-wide Basic Auth, malformed/wrong credential rejection, failed
  login throttling, same-origin JSON/Fetch Metadata checks, and health-only
  unauthenticated access for the private deployment.
- Per-IP and global search quotas, bounded limiter key storage, concurrency
  limits, Retry-After, expiry tests, and slot release after provider failures.
- Allowlisted static files; source, Git configuration, and environment files
  are not served. No arbitrary URL fetch/proxy/download endpoint exists.
- CSP, no-store, nosniff, frame protection, no-referrer, disabled browser
  camera/microphone/geolocation permissions, and configurable HTTPS HSTS.
- Mocked hostile-provider rendering checks, safe result URL filtering, and
  provider errors that do not echo provider bodies or secret values.

Run `npm test`. Tests do not use real credentials, call Brave, place orders,
or modify the deployed service. This project has no third-party npm runtime
or development dependencies; keep the supported Node runtime patched.

## Secrets and operational responsibilities

- Keep production keys/passwords in the hosting platform's managed secret
  environment, accessible only to authorized operators. Use distinct strong
  credentials for Basic Auth and Brave; never reuse the provider token.
- A local `.env` is still plaintext. Git-ignore and environment loading prevent
  accidental inclusion; `dotenv` would load a file, not encrypt it. Restrict
  local filesystem permissions and do not add production secrets to examples,
  logs, browser assets, test fixtures, or support messages.
- Configure edge HTTPS and HTTP-to-HTTPS enforcement with the host; do not
  expose the HTTP origin directly. HSTS is enabled in the Render Blueprint.
- Add WAF/DDoS and shared/durable quotas if the service becomes public or
  multi-instance. Application Origin checks are CSRF protection, not proof of
  identity; non-browser clients can set Origin. Only credentials authenticate.
- Render builds use the committed `package-lock.json` with `npm ci
  --ignore-scripts` to prevent mutable dependency resolution and install-time
  lifecycle scripts.
- Responses use a strict same-origin CSP without `data:` images, HSTS with
  `includeSubDomains` in production, and cross-origin isolation/resource
  headers. The production path forces HSTS even if an operator disables the
  development setting.
- Per-process counters reset on restart and are not monthly provider spend
  controls. Configure provider budgets/alerts independently.
- The application does not log queries or credentials. Verify provider/hosting
  access-log practices, retention, and incident response separately.
- Review changes on a branch before merging to `main`: the README states Render
  deploys from `main`, so merging may trigger a deployment.

## Adversarial verification performed

- 41 local Node security/functional tests passed, including malformed input,
  control characters, undeclared fields, XSS payloads, unsafe URL schemes,
  authentication brute-force throttling, body/response limits, provider
  failures, concurrency, secret-file exposure, security headers, and production
  listener configuration.
- `npm ci --ignore-scripts` completed successfully and `npm audit
  --audit-level=moderate` reported zero vulnerabilities.
- `node --check` passed for every source, browser, and test JavaScript module;
  `git diff --check` passed.
- A tracked-file and full Git-history secret-pattern review found no non-empty
  API key, password, access token, or private-key material. Blank examples and
  test assertions are the only matches.
- No OWASP ZAP, Burp Suite, SQLMap, Snyk, Semgrep, Gitleaks, Trivy, Valgrind,
  JMeter, or Gatling executable is installed here. A production penetration
  test, cloud/WAF review, compliance assessment, and memory/soak test remain
  separate activities requiring authorization and specialized tooling.

## Reporting

Report security concerns privately to the operator contact in the Privacy
Notice. Include affected paths, reproduction steps using dummy data, and
impact. Do not include credentials or publish active secrets in GitHub issues.
