// Serves the static site as-is, plus one small API route for the contact
// form. Everything that isn't POST /api/contact falls straight through to
// the static assets — see wrangler.jsonc's "assets" binding.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

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
