# slebute-site

Marketing landing page for Slebutė (Šeškinė and Pašilaičiai stores, Vilnius).
Static, single-file — no build step, no framework, no bundler. Deploys to
Cloudflare Pages (`slebute.lt`).

## Preview locally

Just open `index.html` in a browser, or serve the directory with any static
file server, e.g.:

```
npx serve .
```

or

```
python -m http.server 8000
```

## Structure

- `index.html` — the entire page (markup, CSS, minimal JS)
- `assets/` — local images (empty for now; page currently uses no image files)
