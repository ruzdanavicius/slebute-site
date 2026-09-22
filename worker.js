// Serves the static site as-is, plus two small API routes: the contact
// form, and a cached read of the featured-products feed. Everything else
// falls straight through to the static assets — see wrangler.jsonc's
// "assets" binding.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }

    if (url.pathname === '/api/featured' && request.method === 'GET') {
      return handleFeatured(ctx);
    }

    return env.ASSETS.fetch(request);
  }
};

// Same anon key already embedded in index.html's page source (and in both
// POS apps) — safe to hold here too, RLS on the underlying tables is the
// real boundary, not key secrecy.
const SUPABASE_URL = 'https://bpxakmnifkrsbjhiytqf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJweGFrbW5pZmtyc2JqaGl5dHFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2MTMzNDgsImV4cCI6MjA4MDE4OTM0OH0.kgfljhRJeLtBIy7U8QU7DEGgRdBwcquH9QVLuhalMEY';

// Which 12 products are eligible already rotates once per calendar day
// server-side (rpc_get_featured_products picks a date-seeded 12 of
// whatever's checked "Feature on website" in Manage Catalogue), so a short
// edge cache here doesn't change what a visitor sees within a given day —
// it only bounds how many times that query actually reaches Postgres.
// Every page load was hitting the production POS database directly,
// uncached; this puts Cloudflare's own cache (already in the request path,
// previously unused) in front of it instead.
const FEATURED_CACHE_SECONDS = 60;

async function handleFeatured(ctx) {
  const cache = caches.default;
  // A fixed, query-string-free cache key — the feed takes no per-visitor
  // input, so every visitor shares one cache entry.
  const cacheKey = new Request('https://slebute.lt/api/featured');

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(SUPABASE_URL + '/rest/v1/rpc/rpc_get_featured_products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY
    },
    body: '{}'
  });

  const bodyText = await upstream.text();

  if (!upstream.ok) {
    // Don't cache a failure — the next request should retry against
    // Supabase rather than being stuck serving an error for 60s.
    return new Response(bodyText, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const response = new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + FEATURED_CACHE_SECONDS
    }
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Neteisingi duomenys.' }, 400);
  }

  const name = String(body.name || '').trim();
  const contact = String(body.contact || '').trim();
  const message = String(body.message || '').trim();
  const honeypot = String(body.website || '').trim();

  // A hidden field real visitors never see or fill — a non-empty value
  // means a bot filled every field on the page. Pretend success so the
  // bot doesn't learn to try again with the field left blank.
  if (honeypot) {
    return jsonResponse({ ok: true });
  }

  if (!name || !contact || !message) {
    return jsonResponse({ ok: false, error: 'Užpildykite visus laukus.' }, 400);
  }
  if (name.length > 200 || contact.length > 200 || message.length > 4000) {
    return jsonResponse({ ok: false, error: 'Tekstas per ilgas.' }, 400);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO contact_submissions (name, contact, message, created_at) VALUES (?, ?, ?, ?)'
    ).bind(name, contact, message, new Date().toISOString()).run();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Nepavyko išsaugoti. Bandykite vėliau.' }, 500);
  }

  return jsonResponse({ ok: true });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
