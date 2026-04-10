export function sendJson(res, status, data) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.send(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const calendarId = process.env.EASYPRACTICE_CALENDAR_ID_STORRE_PENIS;
    const token = process.env.EASYPRACTICE_TOKEN;

    // "Better erection (impotence)" calendar blocks "Bigger penises" slots via
    // EasyPractice blocking rules. We must fetch its bookings too so we don't
    // offer slots that are already blocked by that calendar.
    // Set EASYPRACTICE_CALENDAR_ID_LINKED=630246 in your Vercel env.
    const linkedCalendarId =
      process.env.EASYPRACTICE_CALENDAR_ID_LINKED || null;

    const start = req.query.start;
    const end = req.query.end;
    const debugBookings = req.query.debugBookings === '1';
    const debugOpeningTimes = req.query.debugOpeningTimes === '1';

    if (!start || !end) {
      return sendJson(res, 400, { error: 'Missing start or end' });
    }

    if (!calendarId || !token) {
      return sendJson(res, 500, { error: 'Missing environment variables' });
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const openingRes = await fetch(
      `https://system.easypractice.net/api/v1/calendars/${calendarId}/opening-times`,
      { headers },
    );

    const openingText = await openingRes.text();
    let openingJson = null;
    try {
      openingJson = JSON.parse(openingText);
    } catch (_) {}

    if (!openingRes.ok) {
      return sendJson(res, openingRes.status, {
        error: 'Opening times request failed',
        detail: openingText,
      });
    }

    const openingTimes = openingJson?.data?.times || openingJson?.times || {};

    // Fetch bookings from main calendar + linked calendar in parallel
    function bookingsUrl(calId) {
      return `https://system.easypractice.net/api/v1/bookings?calendar_id=${encodeURIComponent(calId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page_size=200`;
    }

    const [bookingsRes, linkedBookingsRes] = await Promise.all([
      fetch(bookingsUrl(calendarId), { headers }),
      linkedCalendarId
        ? fetch(bookingsUrl(linkedCalendarId), { headers })
        : Promise.resolve(null),
    ]);

    const bookingsText = await bookingsRes.text();
    let bookingsJson = null;
    try {
      bookingsJson = JSON.parse(bookingsText);
    } catch (_) {}

    if (!bookingsRes.ok) {
      return sendJson(res, bookingsRes.status, {
        error: 'Bookings request failed',
        detail: bookingsText,
      });
    }

    // Parse linked calendar bookings (non-fatal if missing/failed)
    let linkedBookingsJson = null;
    if (linkedBookingsRes) {
      try {
        linkedBookingsJson = JSON.parse(await linkedBookingsRes.text());
      } catch (_) {}
    }

    const pausesRes = await fetch(
      `https://system.easypractice.net/api/v1/calendars/${calendarId}/pauses?page_size=200`,
      { headers },
    );

    const pausesText = await pausesRes.text();
    let pausesJson = null;
    try {
      pausesJson = JSON.parse(pausesText);
    } catch (_) {}

    if (!pausesRes.ok) {
      return sendJson(res, pausesRes.status, {
        error: 'Pauses request failed',
        detail: pausesText,
      });
    }

    function extractBookings(json) {
      return Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.bookings)
          ? json.bookings
          : Array.isArray(json)
            ? json
            : [];
    }

    // Merge bookings from both calendars — all block "Bigger penises" slots
    const bookings = [
      ...extractBookings(bookingsJson),
      ...extractBookings(linkedBookingsJson),
    ];

    if (debugOpeningTimes) {
      return sendJson(res, 200, {
        openingTimes,
        rawOpeningJson: openingJson,
      });
    }

    if (debugBookings) {
      return sendJson(res, 200, {
        start,
        end,
        linkedCalendarId: linkedCalendarId || 'not set',
        bookingsCount: bookings?.length,
        mainCalendarBookings: extractBookings(bookingsJson)?.length,
        linkedCalendarBookings: extractBookings(linkedBookingsJson)?.length,
        bookingsSample: bookings?.slice(0, 10),
        pauses: Array.isArray(pausesJson?.data) ? pausesJson.data : pausesJson,
      });
    }

    const pauses = Array.isArray(pausesJson?.data)
      ? pausesJson.data
      : Array.isArray(pausesJson?.pauses)
        ? pausesJson.pauses
        : Array.isArray(pausesJson)
          ? pausesJson
          : [];

    const SLOT_MINUTES = 15;
    const slots = {};

    function pad(n) {
      return String(n).padStart(2, '0');
    }

    function formatDate(d) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function weekdayKey(date) {
      const map = {
        0: 'sunday',
        1: 'monday',
        2: 'tuesday',
        3: 'wednesday',
        4: 'thursday',
        5: 'friday',
        6: 'saturday',
      };
      return map[date.getDay()];
    }

    function toMinutes(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    }

    function minutesToHHMM(mins) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `${pad(h)}:${pad(m)}`;
    }

    function normalizeTime(v) {
      if (!v) return null;
      return String(v).slice(0, 5);
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

    function buildPausesByDate(start, end, pauses) {
      const map = {};

      function addPause(dateKey, startTime, endTime) {
        if (!startTime || !endTime) return;
        if (!map[dateKey]) map[dateKey] = [];
        map[dateKey].push([toMinutes(startTime), toMinutes(endTime)]);
      }

      const current = new Date(`${start}T00:00:00`);
      const last = new Date(`${end}T00:00:00`);

      while (current <= last) {
        const dateKey = formatDate(current);
        const weekday = current.getDay(); // 0=sun ... 6=sat

        pauses.forEach((pause) => {
          const pauseDate = pause.date || pause.pause_date || null;
          const pauseWeekday =
            typeof pause.weekday === 'number'
              ? pause.weekday
              : typeof pause.day_of_week === 'number'
                ? pause.day_of_week
                : null;

          const startTime = normalizeTime(
            pause.start_time || pause.start || pause.from,
          );
          const endTime = normalizeTime(
            pause.end_time || pause.end || pause.to,
          );

          // exact date pause
          if (pauseDate && pauseDate === dateKey) {
            addPause(dateKey, startTime, endTime);
            return;
          }

          // recurring weekday pause
          if (pauseWeekday !== null && pauseWeekday === weekday) {
            addPause(dateKey, startTime, endTime);
          }
        });

        current.setDate(current.getDate() + 1);
      }

      return map;
    }

    function parseBookingDateTime(booking) {
      const startValue =
        booking.start ||
        booking.start_at ||
        booking.starts_at ||
        booking.date ||
        booking.start_time ||
        null;

      const endValue =
        booking.end ||
        booking.end_at ||
        booking.ends_at ||
        booking.end_time ||
        null;

      if (!startValue || !endValue) return null;

      const startDt = new Date(startValue);
      const endDt = new Date(endValue);

      if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) return null;

      return { startDt, endDt };
    }

    const bookedByDate = {};

    for (const booking of bookings) {
      const parsed = parseBookingDateTime(booking);
      if (!parsed) continue;

      const startParts = getClinicDateTimeParts(
        parsed.startDt,
        'Europe/Copenhagen',
      );
      const endParts = getClinicDateTimeParts(
        parsed.endDt,
        'Europe/Copenhagen',
      );

      const dateKey = startParts.dateKey;
      const startMin = startParts.hour * 60 + startParts.minute;
      const endMin = endParts.hour * 60 + endParts.minute;

      if (!bookedByDate[dateKey]) bookedByDate[dateKey] = [];
      bookedByDate[dateKey].push([startMin, endMin]);
    }

    const pausesByDate = buildPausesByDate(start, end, pauses);

    const current = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);

    const minAllowed = getThresholdInClinicTime(8, 'Europe/Copenhagen');

    while (current <= last) {
      const dateKey = formatDate(current);
      const wk = weekdayKey(current);

      const isClosed = openingTimes[`${wk}_closed`];
      const dayStart = openingTimes[`${wk}_start`];
      const dayEnd = openingTimes[`${wk}_end`];

      if (!isClosed && dayStart && dayEnd) {
        const openMin = toMinutes(dayStart);
        const closeMin = toMinutes(dayEnd);
        const booked = bookedByDate[dateKey] || [];
        const paused = pausesByDate[dateKey] || [];
        const blocked = booked.concat(paused);
        const daySlots = [];

        for (let t = openMin; t + SLOT_MINUTES <= closeMin; t += SLOT_MINUTES) {
          const slotStart = t;
          const slotEnd = t + SLOT_MINUTES;
          const slotTime = minutesToHHMM(slotStart);

          // 8-hour future rule
          if (
            dateKey < minAllowed.date ||
            (dateKey === minAllowed.date && slotTime < minAllowed.time)
          ) {
            continue;
          }

          const overlaps = blocked.some(
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
