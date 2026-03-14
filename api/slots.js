export default async function handler(req, res) {
  try {
    const calendarId = process.env.EASYPRACTICE_CALENDAR_ID;
    const token = process.env.EASYPRACTICE_TOKEN;

    const start = req.query.start;
    const end = req.query.end;
    const debug = req.query.debug === '1';

    if (!start || !end) {
      return res.status(400).json({ error: 'Missing start or end' });
    }

    if (!calendarId || !token) {
      return res.status(500).json({ error: 'Missing environment variables' });
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
      return res.status(openingRes.status).json({
        error: 'Opening times request failed',
        detail: openingText,
      });
    }

    const openingTimes = openingJson?.data?.times || {};

    const bookingsRes = await fetch(
      `https://system.easypractice.net/api/v1/bookings?calendar_id=${encodeURIComponent(
        calendarId,
      )}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page_size=200`,
      { headers },
    );

    const bookingsText = await bookingsRes.text();
    let bookingsJson = null;
    try {
      bookingsJson = JSON.parse(bookingsText);
    } catch (_) {}

    if (!bookingsRes.ok) {
      return res.status(bookingsRes.status).json({
        error: 'Bookings request failed',
        detail: bookingsText,
      });
    }

    const bookings = Array.isArray(bookingsJson?.data)
      ? bookingsJson.data
      : Array.isArray(bookingsJson)
        ? bookingsJson
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

      return {
        startRaw: startValue,
        endRaw: endValue,
        startDt,
        endDt,
      };
    }

    const bookedByDate = {};
    const parsedBookingsPreview = [];

    for (const booking of bookings) {
      const parsed = parseBookingDateTime(booking);

      parsedBookingsPreview.push({
        rawKeys: Object.keys(booking || {}),
        raw: booking,
        parsed: parsed
          ? {
              startRaw: parsed.startRaw,
              endRaw: parsed.endRaw,
              startIso: parsed.startDt.toISOString(),
              endIso: parsed.endDt.toISOString(),
            }
          : null,
      });

      if (!parsed) continue;

      const dateKey = formatDate(parsed.startDt);
      const startMin =
        parsed.startDt.getHours() * 60 + parsed.startDt.getMinutes();
      const endMin = parsed.endDt.getHours() * 60 + parsed.endDt.getMinutes();

      if (!bookedByDate[dateKey]) bookedByDate[dateKey] = [];
      bookedByDate[dateKey].push([startMin, endMin]);
    }

    const generationPreview = [];

    const current = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);

    while (current <= last) {
      const dateKey = formatDate(current);
      const wk = weekdayKey(current);

      const isClosed = openingTimes[`${wk}_closed`];
      const dayStart = openingTimes[`${wk}_start`];
      const dayEnd = openingTimes[`${wk}_end`];

      generationPreview.push({
        date: dateKey,
        weekday: wk,
        isClosed,
        dayStart,
        dayEnd,
        booked: bookedByDate[dateKey] || [],
      });

      if (!isClosed && dayStart && dayEnd) {
        const openMin = toMinutes(dayStart);
        const closeMin = toMinutes(dayEnd);
        const booked = bookedByDate[dateKey] || [];
        const daySlots = [];

        for (let t = openMin; t + SLOT_MINUTES <= closeMin; t += SLOT_MINUTES) {
          const slotStart = t;
          const slotEnd = t + SLOT_MINUTES;

          const overlaps = booked.some(
            ([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart,
          );

          if (!overlaps) {
            daySlots.push(minutesToHHMM(slotStart));
          }
        }

        if (daySlots.length) {
          slots[dateKey] = daySlots;
        }
      }

      current.setDate(current.getDate() + 1);
    }

    if (debug) {
      return res.status(200).json({
        slots,
        debug: {
          calendarId,
          openingTimes,
          bookingsCount: bookings.length,
          bookingsSample: parsedBookingsPreview.slice(0, 3),
          generationPreview: generationPreview.slice(0, 10),
          rawOpeningSample: openingJson,
          rawBookingsSample: Array.isArray(bookingsJson?.data)
            ? bookingsJson.data.slice(0, 3)
            : bookingsJson,
        },
      });
    }

    return res.status(200).json({ slots });
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected error',
      detail: error.message,
      stack: error.stack,
    });
  }
}
