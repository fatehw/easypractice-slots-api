/**
 * syncTodayClients.js
 *
 * Vercel Cron Job — runs daily (configure in vercel.json)
 * Fetches all EasyPractice clients created today,
 * then POSTs each one to a Zapier webhook for Airtable sync.
 *
 * Vercel cron config (add to vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/syncTodayClients",
 *     "schedule": "0 23 * * *"
 *   }]
 * }
 *
 * Can also be triggered manually:
 * GET /api/syncTodayClients              → syncs today's clients
 * GET /api/syncTodayClients?date=2026-04-09  → syncs a specific date
 * GET /api/syncTodayClients?debug=1      → returns data without sending to Zapier
 */

export const config = {
  maxDuration: 60, // allow up to 60s for large client lists
};

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.send(JSON.stringify(data));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function getTodayKey() {
  const now = new Date();
  // Use Copenhagen timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

// Fetch ALL clients created on a specific date (handles pagination)
async function fetchClientsCreatedOn(dateKey, token) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const allClients = [];
  let page = 1;
  const pageSize = 100;
  let hasMore = true;

  while (hasMore) {
    const url =
      `https://system.easypractice.net/api/v1/clients` +
      `?order_by_created=desc` +
      `&page_size=${pageSize}` +
      `&page=${page}`;

    const res = await fetch(url, { headers });
    const text = await res.text();

    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}

    if (!res.ok) {
      throw new Error(`EasyPractice clients API error ${res.status}: ${text}`);
    }

    const clients = Array.isArray(json?.data) ? json.data : [];

    // Filter clients created on the target date (in Copenhagen time)
    for (const client of clients) {
      const createdAt = client.created_at || client.createdAt || null;
      if (!createdAt) continue;

      // Parse the created_at date in Copenhagen timezone
      const dt = new Date(createdAt);
      const clientParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Copenhagen',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(dt);
      const cmap = {};
      clientParts.forEach((p) => {
        if (p.type !== 'literal') cmap[p.type] = p.value;
      });
      const clientDateKey = `${cmap.year}-${cmap.month}-${cmap.day}`;

      if (clientDateKey === dateKey) {
        allClients.push(client);
      }

      // Since results are ordered by created desc,
      // if we hit a date before our target we can stop paginating
      if (clientDateKey < dateKey) {
        hasMore = false;
        break;
      }
    }

    // Check if there are more pages
    const lastPage = json?.meta?.last_page || 1;
    if (page >= lastPage || clients.length < pageSize) {
      hasMore = false;
    } else {
      page++;
    }
  }

  return allClients;
}

// Send one client to Zapier webhook
async function sendToZapier(webhookUrl, client, dateKey) {
  const payload = {
    // ── Sync metadata ──
    sync_date: dateKey,
    sync_source: 'easypractice_daily_sync',
    triggered_at: new Date().toISOString(),

    // ── EasyPractice client data ──
    easypractice_id: client.id,
    name: client.name || '',
    email: client.email || '',
    phone: client.phone || '',
    status: client.status || '',
    created_at: client.created_at || '',

    // ── Tags (comma-separated names for easy Zapier filtering) ──
    tags: Array.isArray(client.tags)
      ? client.tags.map((t) => t.name || t.label || String(t)).join(', ')
      : '',
    tags_raw: JSON.stringify(client.tags || []),

    // ── Address ──
    address: client.address || '',
    city: client.city || '',
    zip: client.zip || '',
    country: client.country || '',
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return res.ok;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  // Simple cron secret check to prevent unauthorized triggers
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization || '';
    const querySecret = req.query.secret || '';
    if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
  }

  try {
    const token = process.env.EASYPRACTICE_CLIENT_TOKEN;
    const webhookUrl = process.env.ZAPIER_SYNC_CLIENTS_WEBHOOK_URL;
    const debug = req.query.debug === '1';
    const dateKey = req.query.date || getTodayKey();

    if (!token) {
      return sendJson(res, 500, {
        error: 'Missing EASYPRACTICE_CLIENT_TOKEN env var',
      });
    }

    if (!webhookUrl && !debug) {
      return sendJson(res, 500, {
        error: 'Missing ZAPIER_SYNC_CLIENTS_WEBHOOK_URL env var',
      });
    }

    // Fetch all clients created on the target date
    const clients = await fetchClientsCreatedOn(dateKey, token);

    // Debug mode — return raw data, don't send to Zapier
    if (debug) {
      return sendJson(res, 200, {
        date: dateKey,
        clientsFound: clients.length,
        clients: clients.map((c) => ({
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          created_at: c.created_at,
          status: c.status,
        })),
      });
    }

    // Send each client to Zapier
    const results = [];
    for (const client of clients) {
      const ok = await sendToZapier(webhookUrl, client, dateKey);
      results.push({
        id: client.id,
        name: client.name,
        email: client.email,
        success: ok,
      });
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    return sendJson(res, 200, {
      date: dateKey,
      clientsFound: clients.length,
      sentToZapier: successCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Unexpected error',
      detail: error.message,
    });
  }
}
