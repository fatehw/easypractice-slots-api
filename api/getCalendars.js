export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const token = process.env.EASYPRACTICE_CALENDAR_TOKEN;

    if (!token) {
      return res
        .status(500)
        .json({ error: 'Missing environment variable: EASYPRACTICE_TOKEN' });
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // API endpoint to get all calendars
    const calendarsRes = await fetch(
      'https://system.easypractice.net/api/v1/calendars',
      {
        method: 'GET',
        headers: headers,
      },
    );

    if (!calendarsRes.ok) {
      return res
        .status(calendarsRes.status)
        .json({ error: 'Failed to fetch calendars' });
    }

    const calendars = await calendarsRes.json();

    // Respond with the list of calendars
    return res.status(200).json(calendars);
  } catch (error) {
    console.error('Error fetching calendars:', error);
    return res
      .status(500)
      .json({ error: 'Unexpected error', detail: error.message });
  }
}
