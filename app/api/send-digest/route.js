/**
 * app/api/send-digest/route.js
 *
 * Scheduled cron endpoint that emails users a daily digest of their price alerts
 * that have dropped below target. Invoked by an external scheduler (cron-job.org)
 * on a fixed schedule.
 *
 * Highlights this file demonstrates:
 *   - A shared-secret guard so only the scheduler can trigger the job.
 *   - Supabase with the service-role key (bypasses row-level security) plus the
 *     Admin API to resolve user emails server-side.
 *   - Grouping triggered alerts per user so each person gets a single email.
 *   - Transactional email delivery via Resend, then marking alerts as notified
 *     only after a successful send (so a failed send is retried next run).
 *
 * Notes for readers:
 *   - All credentials are read from environment variables; none are embedded.
 *   - Identifiers, comments and copy were translated from Italian for this showcase.
 *   - Table/column names are anglicised to match the rest of this repo.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const FROM_ADDRESS = 'Dealvy <noreply@dealvy.online>';
const SITE_URL = 'https://dealvy.online';

export async function GET(request) {
  // --- Auth: the scheduler must present the shared secret --------------------
  const authHeader = request.headers.get('authorization');
  const urlSecret = new URL(request.url).searchParams.get('secret');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && urlSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Service-role client: needed to read every user's alerts and resolve emails.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // Pull alerts that have triggered but not yet been notified.
    const { data: alerts, error: alertError } = await supabase
      .from('price_alerts')
      .select('*')
      .eq('active', true)
      .not('triggered_at', 'is', null)
      .is('notified_at', null)
      .limit(50);

    if (alertError) {
      return NextResponse.json({ error: alertError.message }, { status: 500 });
    }
    if (!alerts || alerts.length === 0) {
      return NextResponse.json({ message: 'No alerts to notify' });
    }

    // Group alerts by user so each person receives a single digest email.
    const byUser = {};
    for (const alert of alerts) {
      (byUser[alert.user_id] ||= []).push(alert);
    }

    let emailsSent = 0;

    for (const [userId, userAlerts] of Object.entries(byUser)) {
      try {
        // Resolve the user's email via the Admin API (not exposed to clients).
        const { data: userData } = await supabase.auth.admin.getUserById(userId);
        const email = userData?.user?.email;
        if (!email) continue;

        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [email],
            subject: `${userAlerts.length === 1 ? '1 price alert' : `${userAlerts.length} price alerts`} — your products just dropped!`,
            html: buildDigestEmail(userAlerts),
          }),
        });

        // Only mark as notified (and deactivate) once the email actually went out,
        // so a delivery failure is naturally retried on the next run.
        if (response.ok) {
          const ids = userAlerts.map(a => a.id);
          await supabase
            .from('price_alerts')
            .update({ notified_at: new Date().toISOString(), active: false })
            .in('id', ids);
          emailsSent++;
        }
      } catch (e) {
        console.error('Digest error for user:', userId, e);
      }
    }

    return NextResponse.json({ usersNotified: emailsSent, alertsProcessed: alerts.length });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// --- Email template ----------------------------------------------------------
// Kept as a pure function so the request handler stays readable.

function buildDigestEmail(alerts) {
  const items = alerts.map(a => `
    <div style="border:1px solid #e0e0e0;border-radius:10px;padding:1rem;margin-bottom:1rem;background:#fafafa;">
      ${a.image ? `<img src="${a.image}" alt="${escapeHtml(a.title)}" style="width:80px;height:80px;object-fit:contain;float:left;margin-right:1rem;border-radius:6px;background:white;" />` : ''}
      <div style="overflow:hidden;">
        <div style="font-size:0.85rem;color:#333;margin-bottom:0.5rem;">${escapeHtml(truncate(a.title, 80))}</div>
        <div style="display:inline-block;background:#f0fff8;color:#00a855;font-weight:800;font-size:1.1rem;padding:0.2rem 0.6rem;border-radius:6px;margin-right:0.5rem;">€${a.reached_price}</div>
        <div style="display:inline-block;color:#7a8a95;font-size:0.78rem;">Target: €${a.target_price}</div>
        <div style="margin-top:0.6rem;">
          <a href="${a.link}" style="background:#0B3954;color:#00E676;padding:0.35rem 0.85rem;border-radius:6px;text-decoration:none;font-size:0.8rem;font-weight:700;">View deal →</a>
        </div>
      </div>
      <div style="clear:both;"></div>
    </div>
  `).join('');

  const headline = alerts.length === 1
    ? 'A product dropped below your target price!'
    : `${alerts.length} products dropped below your target price!`;

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F5F7FA;">
      <div style="background:linear-gradient(135deg,#0B3954,#0d4a6b);padding:2rem;text-align:center;">
        <div style="font-size:2rem;font-weight:900;color:white;letter-spacing:4px;">DE<span style="color:#00E676;">A</span>LVY</div>
        <div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:0.25rem;">Shop Everywhere. Pay the Least.</div>
      </div>
      <div style="padding:1.5rem;background:white;margin:1rem;border-radius:12px;">
        <div style="font-size:1.1rem;font-weight:700;color:#0B3954;margin-bottom:0.5rem;">${headline}</div>
        <div style="color:#7a8a95;font-size:0.85rem;margin-bottom:1.5rem;">Act before prices climb back up.</div>
        ${items}
        <div style="text-align:center;margin-top:1.5rem;">
          <a href="${SITE_URL}" style="background:#0B3954;color:#00E676;padding:0.85rem 2rem;border-radius:10px;text-decoration:none;font-weight:700;">Go to Dealvy →</a>
        </div>
      </div>
      <div style="text-align:center;padding:1rem;color:#aab;font-size:0.75rem;">
        <a href="${SITE_URL}" style="color:#0B3954;">dealvy.online</a>
      </div>
    </div>
  `;
}

function truncate(str, max) {
  const s = str || '';
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// Minimal HTML escaping for values interpolated into the email markup.
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
