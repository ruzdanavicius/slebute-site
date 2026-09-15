# slebute-site

Marketing landing page for Slebutė (Šeškinė and Pašilaičiai stores, Vilnius).
The page itself is static (no build step, no framework, no bundler). Deploys
as a Cloudflare Worker with static assets (`slebute.lt`), connected to this
GitHub repo — a git push triggers a new build automatically.

## Preview locally

For the static page only (no `/api/contact`, no D1):

```
npx serve .
```

or

```
python -m http.server 8000
```

To exercise the full thing, including the contact form's D1-backed API
route, use Wrangler instead:

```
npx wrangler dev
```

## Structure

- `index.html` — the page itself (markup, CSS, minimal JS)
- `assets/` — local images
- `worker.js` — the Worker entry point: serves static assets for everything
  except `POST /api/contact`, which it handles itself
- `wrangler.jsonc` — Worker config (static assets binding + the
  `slebute-contacts` D1 database binding)
- `.assetsignore` — keeps `worker.js`/`wrangler.jsonc`/this file out of the
  publicly-served static assets

## Contact form data

Submissions land in the `slebute-contacts` D1 database, table
`contact_submissions` (`name`, `contact`, `message`, `created_at`). Query it
via the Cloudflare dashboard (Workers & Pages → D1 → slebute-contacts) or
`wrangler d1 execute slebute-contacts --remote --command "SELECT * FROM contact_submissions"`.
