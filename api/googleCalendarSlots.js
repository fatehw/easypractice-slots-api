import crypto from 'crypto';

export function sendJson(res, status, data) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.send(JSON.stringify(data));
}

// ─── Working hours config ───────────────────────────────────────────────────
// Set GOOGLE_WORKING_HOURS env var as a JSON string to override these defaults.
// The doctor manages EXCEPTIONS (busy times, holidays, specific day blocks)
// entirely via Google Calendar events. These are the regular open/close windows.
//
// Example env var value:
// {"monday":{"open":"08:00","close":"17:00","closed":false},"saturday":{"closed":true},...}
//
const DEFAULT_WORKING_HOURS = {
  monday: { open: '01:00', close: '24:00', closed: false },
  tuesday: { open: '01:00', close: '24:00', closed: false },
  wednesday: { open: '01:00', close: '24:00', closed: false },
  thursday: { open: '01:00', close: '24:00', closed: false },
  friday: { open: '01:00', close: '24:00', closed: false },
  saturday: { open: '01:00', close: '24:00', closed: true },
  sunday: { open: '01:00', close: '24:00', closed: true },
};

// ─── Google Service Account JWT auth (no npm packages needed) ───────────────

function createServiceAccountJWT(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');

  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');

  return `${header}.${payload}.${signature}`;
}

async function getAccessToken(clientEmail, privateKey) {
  const jwt = createServiceAccountJWT(clientEmail, privateKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(
      'Failed to get Google access token: ' + JSON.stringify(data),
    );
  }
  return data.access_token;
}

// ─── Google Calendar FreeBusy API ────────────────────────────────────────────

async function fetchBusyTimes(accessToken, calendarId, start, end) {
  // Add 1 day to end so we capture the full end date in all timezones
  const endDate = new Date(`${end}T00:00:00Z`);
  endDate.setDate(endDate.getDate() + 1);
  const timeMax = endDate.toISOString();

  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      timeMin: `${start}T00:00:00Z`,
      timeMax,
      timeZone: 'Europe/Copenhagen',
      items: [{ id: calendarId }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('FreeBusy API error: ' + JSON.stringify(data));
  }

  // Returns array of { start: ISO string, end: ISO string }
  return data.calendars?.[calendarId]?.busy || [];
}

// ─── Shared helpers (same logic as storrePenisSlots.js) ──────────────────────

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function weekdayKey(date) {
  return WEEKDAY_KEYS[date.getDay()];
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

function getClinicDateTimeParts(dateInput, timeZone = 'Europe/Copenhagen') {
  const dt = new Date(dateInput);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(dt);

  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });

  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function getThresholdInClinicTime(
  hoursAhead = 8,
  timeZone = 'Europe/Copenhagen',
) {
  const target = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(target);

  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
  };
}

// Convert Google busy times (ISO strings) to per-date minute ranges
function buildBusyByDate(busyTimes) {
  const map = {};

  for (const busy of busyTimes) {
    const startParts = getClinicDateTimeParts(busy.start, 'Europe/Copenhagen');
    const endParts = getClinicDateTimeParts(busy.end, 'Europe/Copenhagen');

    const dateKey = startParts.dateKey;
    const startMin = startParts.hour * 60 + startParts.minute;
    const endMin = endParts.hour * 60 + endParts.minute;

    // Handle multi-day busy blocks (e.g. all-day events spanning several days)
    if (endParts.dateKey !== startParts.dateKey) {
      // Block from start to end of first day
      if (!map[startParts.dateKey]) map[startParts.dateKey] = [];
      map[startParts.dateKey].push([startMin, 24 * 60]);

      // Block full days in between
      const cur = new Date(startParts.dateKey + 'T12:00:00Z');
      cur.setDate(cur.getDate() + 1);
      while (formatDate(cur) < endParts.dateKey) {
        const k = formatDate(cur);
        if (!map[k]) map[k] = [];
        map[k].push([0, 24 * 60]);
        cur.setDate(cur.getDate() + 1);
      }

      // Block start of last day up to end time
      if (endMin > 0) {
        if (!map[endParts.dateKey]) map[endParts.dateKey] = [];
        map[endParts.dateKey].push([0, endMin]);
      } else {
        // End at midnight = whole previous day is blocked, last day fully free
        if (!map[endParts.dateKey]) map[endParts.dateKey] = [];
        map[endParts.dateKey].push([0, 24 * 60]);
      }
    } else {
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push([startMin, endMin]);
    }
  }

  return map;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    const start = req.query.start;
    const end = req.query.end;
    const debugBusy = req.query.debugBusy === '1';

    if (!start || !end) {
      return sendJson(res, 400, { error: 'Missing start or end query params' });
    }

    if (!serviceAccountJson || !calendarId) {
      return sendJson(res, 500, {
        error:
          'Missing environment variables: GOOGLE_SERVICE_ACCOUNT_JSON and/or GOOGLE_CALENDAR_ID',
      });
    }

    // Parse service account JSON (stored as base64 in env)
    let sa;
    try {
      sa = JSON.parse(
        Buffer.from(serviceAccountJson, 'base64').toString('utf8'),
      );
    } catch (_) {
      return sendJson(res, 500, {
        error:
          'Invalid GOOGLE_SERVICE_ACCOUNT_JSON — must be base64-encoded JSON',
      });
    }

    // Get working hours config (env override or defaults)
    let workingHours = DEFAULT_WORKING_HOURS;
    if (process.env.GOOGLE_WORKING_HOURS) {
      try {
        const override = JSON.parse(process.env.GOOGLE_WORKING_HOURS);
        workingHours = { ...DEFAULT_WORKING_HOURS, ...override };
      } catch (_) {
        console.warn('Invalid GOOGLE_WORKING_HOURS env var — using defaults');
      }
    }

    // Authenticate + fetch busy times
    const accessToken = await getAccessToken(sa.client_email, sa.private_key);
    const busyTimes = await fetchBusyTimes(accessToken, calendarId, start, end);

    // Debug mode — return raw busy data for inspection
    if (debugBusy) {
      return sendJson(res, 200, {
        start,
        end,
        calendarId,
        busyCount: busyTimes.length,
        busyTimes,
      });
    }

    const busyByDate = buildBusyByDate(busyTimes);
    const SLOT_MINUTES = 15;
    const slots = {};
    const minAllowed = getThresholdInClinicTime(8, 'Europe/Copenhagen');

    const current = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);

    while (current <= last) {
      const dateKey = formatDate(current);
      const wk = weekdayKey(current);
      const wh = workingHours[wk];

      if (wh && !wh.closed && wh.open && wh.close) {
        const openMin = toMinutes(wh.open);
        const closeMin = toMinutes(wh.close);
        const busy = busyByDate[dateKey] || [];
        const daySlots = [];

        for (let t = openMin; t + SLOT_MINUTES <= closeMin; t += SLOT_MINUTES) {
          const slotStart = t;
          const slotEnd = t + SLOT_MINUTES;
          const slotTime = minutesToHHMM(slotStart);

          // 8-hour future rule (same as EasyPractice API)
          if (
            dateKey < minAllowed.date ||
            (dateKey === minAllowed.date && slotTime < minAllowed.time)
          ) {
            continue;
          }

          // Skip if overlaps with any busy block
          const overlaps = busy.some(
            ([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart,
          );

          if (!overlaps) {
            daySlots.push(slotTime);
          }
        }

        if (daySlots.length) {
          slots[dateKey] = daySlots;
        }
      }

      current.setDate(current.getDate() + 1);
    }

    return sendJson(res, 200, { slots });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Unexpected error',
      detail: error.message,
    });
  }
}
