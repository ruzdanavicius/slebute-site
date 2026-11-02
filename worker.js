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

    if (url.pathname.startsWith('/img/') && request.method === 'GET') {
      return handleImage(url, ctx);
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

  let bodyText = await upstream.text();

  if (!upstream.ok) {
    // Don't cache a failure — the next request should retry against
    // Supabase rather than being stuck serving an error for 60s.
    return new Response(bodyText, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  bodyText = routePhotosThroughEdge(bodyText);

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

// Product photos live in Supabase's public "pos-images" bucket, which serves
// them `Cache-Control: private, no-cache` — every page view was a fresh
// download from Supabase (the egress we pay for). The feed below rewrites
// those URLs to this Worker's own /img/<file> route, which downloads each
// photo from Supabase once and then serves it from Cloudflare's cache (and the
// visitor's browser) for a year. Safe because the app names every upload
// uniquely (timestamp + random), so a replaced photo is always a new URL.
const PHOTO_PREFIX = SUPABASE_URL + '/storage/v1/object/public/pos-images/';
const PHOTO_NAME = /^[A-Za-z0-9._-]{1,128}\.(jpe?g|png|webp|gif|avif)$/i;
const PHOTO_CACHE_SECONDS = 31536000;

// Rewrites the Supabase photo URLs in the featured feed to /img/<file>. Any
// other URL, or a feed that isn't the expected JSON, passes through untouched.
function routePhotosThroughEdge(bodyText) {
  try {
    const items = JSON.parse(bodyText);
    if (!Array.isArray(items)) return bodyText;
    items.forEach(function (item) {
      if (!item || !Array.isArray(item.images)) return;
      item.images = item.images.map(function (src) {
        if (typeof src !== 'string' || !src.startsWith(PHOTO_PREFIX)) return src;
        const name = src.slice(PHOTO_PREFIX.length);
        return PHOTO_NAME.test(name) ? '/img/' + name : src;
      });
    });
    return JSON.stringify(items);
  } catch (e) {
    return bodyText;
  }
}

async function handleImage(url, ctx) {
  const name = url.pathname.slice('/img/'.length);
  // Only plain file names from the one bucket — never a path, so this can't be
  // used to read anything else from Supabase or to proxy arbitrary URLs.
  if (!PHOTO_NAME.test(name)) {
    return new Response('Not found', { status: 404 });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.origin + '/img/' + name);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(PHOTO_PREFIX + name);
  const type = upstream.headers.get('Content-Type') || '';
  if (!upstream.ok || !type.startsWith('image/')) {
    // Missing or odd — don't cache, so a photo uploaded a moment later works.
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  const response = new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=' + PHOTO_CACHE_SECONDS + ', immutable'
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

  // The D1 row above is the durable record of this submission — a failed
  // notification email must never fail the customer's submission, so this
  // is best-effort and swallows its own errors.
  try {
    await notifyNewContact(env, name, contact, message);
  } catch (e) {
    console.error('Contact notification email failed:', e);
  }

  return jsonResponse({ ok: true });
}

// Requires the slebute.lt domain to be onboarded to Cloudflare Email
// Service (adds SPF/DKIM records) and uzdanavicius@gmail.com verified as a
// destination address — see the send_email binding in wrangler.jsonc.
// Until both are done, env.EMAIL.send() will reject and this is silently
// logged, not surfaced to the customer.
async function notifyNewContact(env, name, contact, message) {
  await env.EMAIL.send({
    from: 'kontaktai@slebute.lt',
    to: 'uzdanavicius@gmail.com',
    subject: 'Nauja užklausa iš slebute.lt — ' + name,
    text: 'Vardas: ' + name + '\nKontaktas: ' + contact + '\n\nŽinutė:\n' + message
  });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
