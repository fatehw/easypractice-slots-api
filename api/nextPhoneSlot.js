/**
 * nextPhoneSlot.js
 *
 * Returns the next available phone call slot (17:00–19:00, 30-min duration)
 * from the phone call calendar in EasyPractice.
 *
 * Query params:
 *   time  = "any"  → returns first available slot between 17:00–19:00
 *   time  = "17:00" | "17:30" | "18:00" | "18:30" → returns first available
 *           day where that specific time is free
 *
 * Env vars needed:
 *   EASYPRACTICE_TOKEN
 *   EASYPRACTICE_CALENDAR_ID_PHONE_CALL  ← set this to the Telefonsamtale calendar ID
 *
 * Response:
 * {
 *   found: true,
 *   date: "2026-04-21",
 *   time: "17:30",
 *   start: "2026-04-21T17:30:00+02:00",
 *   end:   "2026-04-21T18:00:00+02:00"
 * }
 * or { found: false } if nothing available in the next 14 days
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  function sendJson(status, data) {
    res.status(status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(data));
  }

  try {
    const calendarId = process.env.EASYPRACTICE_CALENDAR_ID_PHONE_CALL;
    const token      = process.env.EASYPRACTICE_TOKEN;
    const timeParam  = req.query.time || 'any'; // "any" | "17:00" | "17:30" | "18:00" | "18:30"

    if (!calendarId || !token) {
      return sendJson(500, { error: 'Missing env vars: EASYPRACTICE_CALENDAR_ID_PHONE_CALL or EASYPRACTICE_TOKEN' });
    }

    const VALID_TIMES = [
      '17:00',
      '17:15',
      '17:30',
      '17:45',
      '18:00',
      '18:15',
      '18:30',
      '18:45',
      '19:00',
    ];
    const DURATION_MIN = 15;
    const SEARCH_DAYS  = 14; // look ahead up to 14 days

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    function pad(n) { return String(n).padStart(2, '0'); }

    function formatDate(d) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // Get Copenhagen local date/time parts from a UTC Date
    function getCopenhagenParts(dt) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Copenhagen',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(dt);
      const map = {};
      parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });
      return {
        dateKey: `${map.year}-${map.month}-${map.day}`,
        hour: Number(map.hour),
        minute: Number(map.minute),
      };
    }

    // Get Copenhagen UTC offset string for a given Date (+02:00 or +01:00)
    function getCopenhagenOffset(dt) {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Copenhagen',
        timeZoneName: 'longOffset',
      });
      const parts = formatter.formatToParts(dt);
      const tzName = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+2';
      const match = tzName.match(/GMT([+-]\d+)/);
      const h = match ? parseInt(match[1]) : 2;
      return (h >= 0 ? '+' : '-') + String(Math.abs(h)).padStart(2, '0') + ':00';
    }

    function toMinutes(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    }

    function minutesToHHMM(mins) {
      return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    }

    // ── Date range for search ──────────────────────────────────────────────

    // "Today" in Copenhagen time
    const nowUtc = new Date();
    const todayParts = getCopenhagenParts(nowUtc);
    const todayKey = todayParts.dateKey;

    const endSearchDate = new Date(nowUtc.getTime() + SEARCH_DAYS * 24 * 60 * 60 * 1000);
    const endKey = formatDate(endSearchDate);

    // ── Fetch existing bookings for the phone call calendar ────────────────

    const bookingsRes = await fetch(
      `https://system.easypractice.net/api/v1/bookings` +
      `?calendar_id=${encodeURIComponent(calendarId)}` +
      `&start=${encodeURIComponent(todayKey)}` +
      `&end=${encodeURIComponent(endKey)}` +
      `&page_size=200`,
      { headers },
    );

    let bookingsJson = null;
    try { bookingsJson = await bookingsRes.json(); } catch (_) {}
    if (!bookingsRes.ok) {
      return sendJson(bookingsRes.status, { error: 'Failed to fetch bookings' });
    }

    const bookings = Array.isArray(bookingsJson?.data) ? bookingsJson.data
      : Array.isArray(bookingsJson?.bookings) ? bookingsJson.bookings
      : [];

    // Build busy map: { "YYYY-MM-DD": [[startMin, endMin], ...] }
    const busyByDate = {};
    for (const booking of bookings) {
      const startVal = booking.start || booking.start_at || booking.starts_at || null;
      const endVal   = booking.end   || booking.end_at   || booking.ends_at   || null;
      if (!startVal || !endVal) continue;

      const startDt = new Date(startVal);
      const endDt   = new Date(endVal);
      if (isNaN(startDt) || isNaN(endDt)) continue;

      const sp = getCopenhagenParts(startDt);
      const ep = getCopenhagenParts(endDt);
      if (!busyByDate[sp.dateKey]) busyByDate[sp.dateKey] = [];
      busyByDate[sp.dateKey].push([sp.hour * 60 + sp.minute, ep.hour * 60 + ep.minute]);
    }

    // ── Which times to try ────────────────────────────────────────────────

    const timesToTry = (timeParam === 'any') ? VALID_TIMES : [timeParam];

    // ── Search for next available slot ────────────────────────────────────

    const cursor = new Date(todayKey + 'T00:00:00Z');
    const last   = new Date(endKey   + 'T00:00:00Z');

    while (cursor <= last) {
      const dow     = cursor.getUTCDay(); // 0=Sun, 6=Sat — weekdays only (Mon–Fri)
      const dateKey = formatDate(cursor);

      if (dow >= 1 && dow <= 5) { // Mon–Fri only
        const busy = busyByDate[dateKey] || [];

        for (const t of timesToTry) {
          const slotStart = toMinutes(t);
          const slotEnd   = slotStart + DURATION_MIN;

          // Must be within 17:00–19:00
          if (slotStart < toMinutes('17:00') || slotEnd > toMinutes('19:00')) continue;

          // Skip if today and slot is already in the past (Copenhagen time)
          if (dateKey === todayKey) {
            const nowCopenhagenMin = todayParts.hour * 60 + todayParts.minute;
            if (slotStart <= nowCopenhagenMin) continue;
          }

          // Check no overlap with existing bookings
          const overlaps = busy.some(([bs, be]) => slotStart < be && slotEnd > bs);
          if (!overlaps) {
            // Found! Build ISO start/end strings
            const slotDate = new Date(`${dateKey}T${t}:00`);
            const offset   = getCopenhagenOffset(slotDate);
            const endTime  = minutesToHHMM(slotEnd);

            return sendJson(200, {
              found:  true,
              date:   dateKey,
              time:   t,
              start:  `${dateKey}T${t}:00${offset}`,
              end:    `${dateKey}T${endTime}:00${offset}`,
            });
          }
        }
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Nothing found in search window
    return sendJson(200, { found: false });

  } catch (error) {
    return res.status(500).json({ error: 'Unexpected error', detail: error.message });
  }
}
