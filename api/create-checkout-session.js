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
// Required Vercel environment variable:
//   STRIPE_SECRET_KEY = sk_live_...   (set in Vercel dashboard, never committed)

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SITE_URL = 'https://irenthousesinsweats.com';
const MIN_AMOUNT_CENTS = 100;        // $1.00 minimum, matches existing dashboard validation
const MAX_AMOUNT_CENTS = 10000000;   // $100,000 ceiling as a sanity guard against abuse/typos

module.exports = async (req, res) => {
  // Basic CORS headers (harmless even for same-origin calls; protects preview domains too)
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const { amount, email, address } = req.body || {};

    const amountNum = Number(amount);
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

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }

    const propertyLabel = typeof address === 'string' && address.trim() ? address.trim() : 'your rental property';

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
      success_url: `${SITE_URL}/dashboard?paid=success`,
      cancel_url: `${SITE_URL}/dashboard?paid=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session creation failed:', err);
    res.status(500).json({ error: 'Something went wrong setting up your payment. Please try again or contact Neela.' });
  }
};
