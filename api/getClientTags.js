export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const token = process.env.EASYPRACTICE_CLIENT_TOKEN;

    if (!token) {
      return res.status(500).json({
        error: 'Missing environment variable: EASYPRACTICE_CLIENT_TOKEN',
      });
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const tagsRes = await fetch(
      'https://system.easypractice.net/api/v1/client-tags?order_by_name=asc&page_size=50',
      {
        method: 'GET',
        headers: headers,
      },
    );

    if (!tagsRes.ok) {
      return res
        .status(tagsRes.status)
        .json({ error: 'Failed to fetch client tags' });
    }

    const tags = await tagsRes.json();

    return res.status(200).json(tags);
  } catch (error) {
    console.error('Error fetching client tags:', error);
    return res
      .status(500)
      .json({ error: 'Unexpected error', detail: error.message });
  }
}
