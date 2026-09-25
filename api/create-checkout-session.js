// /api/create-checkout-session.js
//
// Vercel Serverless Function.
// Creates a real Stripe Checkout Session with the exact rent amount the
// tenant entered, so the amount is already locked in when Stripe's page
// loads — no re-typing required.
//
// Why this exists: Stripe Payment Links do NOT support a "prefilled_amount"
// URL parameter for "customer chooses price" links. That parameter is not
// part of Stripe's API and is silently ignored. The only reliable way to
// hand Stripe an exact amount ahead of time is to create a Checkout Session
// server-side (which requires the secret key, so it can't run in the browser).
//
// Identity (added Sep 2026, F1): the tenant is identified ONLY from the
// Supabase access token sent in the Authorization header. The server verifies
// the token with Supabase, looks up the tenant row by user_id (RLS restricts
// this to the caller's own row), and attaches irhis_flow / user_id /
// property_id metadata. That metadata routes the payment to the
// IRHIS PORTAL PAYMENT RECONCILIATION scenario (paid-gated, user_id-matched,
// duplicate-proof). Nothing in the request body is trusted for identity.
//
// Required Vercel environment variable:
//   STRIPE_SECRET_KEY = sk_live_...   (set in Vercel dashboard, never committed)
//
// SUPABASE_URL / SUPABASE_KEY below are the same PUBLIC values already
// shipped in dashboard/index.html (anon key, protected by RLS). They are not
// secrets. NEVER put the service_role key in this file.

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SITE_URL = 'https://irenthousesinsweats.com';
const MIN_AMOUNT_CENTS = 100;        // $1.00 minimum, matches existing dashboard validation
const MAX_AMOUNT_CENTS = 10000000;   // $100,000 ceiling as a sanity guard against abuse/typos

const SUPABASE_URL = 'https://dzhdwremvptmtacvmxlq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6aGR3cmVtdnB0bXRhY3ZteGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NDg2MDgsImV4cCI6MjA5ODUyNDYwOH0.xb_yw_w3AIpzn-cVZTm_1iqY-IE99oJxSnaa6jMExDQ';

async function supabaseRequest(path, token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

module.exports = async (req, res) => {
  // Basic CORS headers (harmless even for same-origin calls; protects preview domains too)
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: 'Payment service is not configured. Please contact Neela.' });
    return;
  }

  // No token usually means an old dashboard tab loaded before this update
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Please refresh this page and try again.' });
    return;
  }
  const accessToken = match[1];

  try {
    const amountNum = Number((req.body || {}).amount);
    if (!amountNum || Number.isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: 'A valid payment amount is required.' });
      return;
    }

    const amountInCents = Math.round(amountNum * 100);

    if (amountInCents < MIN_AMOUNT_CENTS) {
      res.status(400).json({ error: 'Payment amount must be at least $1.00.' });
      return;
    }
    if (amountInCents > MAX_AMOUNT_CENTS) {
      res.status(400).json({ error: 'Payment amount is too large. Please contact Neela directly for this payment.' });
      return;
    }

    // 1. Verify the token and get the real user id
    const userResult = await supabaseRequest('/auth/v1/user', accessToken);
    const userId = userResult.data && userResult.data.id;
    if (!userResult.ok || !userId) {
      res.status(401).json({ error: 'Your session expired. Please log in again.' });
      return;
    }

    // 2. Tenant row (RLS: caller can only see their own)
    const tenantResult = await supabaseRequest(
      `/rest/v1/tenants?user_id=eq.${encodeURIComponent(userId)}&select=property_id,email,is_active`,
      accessToken
    );
    const tenantRows = Array.isArray(tenantResult.data) ? tenantResult.data : [];
    if (!tenantResult.ok || tenantRows.length !== 1) {
      res.status(403).json({ error: 'We could not find your tenant account. Please contact Neela at (419) 902-7728.' });
      return;
    }
    const tenant = tenantRows[0];
    if (!tenant.is_active) {
      res.status(403).json({ error: 'Your account is not active. Please contact Neela at (419) 902-7728.' });
      return;
    }

    // 3. Property row
    const propertyResult = await supabaseRequest(
      `/rest/v1/properties?id=eq.${encodeURIComponent(tenant.property_id)}&select=id,address,monthly_rent`,
      accessToken
    );
    const propertyRows = Array.isArray(propertyResult.data) ? propertyResult.data : [];
    if (!propertyResult.ok || propertyRows.length !== 1) {
      res.status(403).json({ error: 'We could not find your property. Please contact Neela at (419) 902-7728.' });
      return;
    }
    const property = propertyRows[0];

    const email = tenant.email || (userResult.data && userResult.data.email) || undefined;
    const propertyLabel = typeof property.address === 'string' && property.address.trim()
      ? property.address.trim()
      : 'your rental property';

    // Routes the payment to IRHIS PORTAL PAYMENT RECONCILIATION.
    // Copied onto the PaymentIntent too, for future refund handling.
    const metadata = {
      irhis_flow: 'tenant_portal',
      user_id: userId,
      property_id: property.id,
      monthly_rent: String(property.monthly_rent),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Rent Payment',
              description: `Monthly rent payment for ${propertyLabel}. Covers your base rent and any pet rent due for the current month. Questions? Contact Neela at (419) 902-7728.`,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${SITE_URL}/dashboard?paid=success`,
      cancel_url: `${SITE_URL}/dashboard?paid=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session creation failed:', err);
    res.status(500).json({ error: 'Something went wrong setting up your payment. Please try again or contact Neela.' });
  }
};
