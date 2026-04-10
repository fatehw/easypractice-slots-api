export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  try {
    const token = process.env.EASYPRACTICE_PRODUCTS_TOKEN;

    if (!token) {
      return res.status(500).json({ error: 'Missing EASYPRACTICE_TOKEN' });
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const servicesRes = await fetch(
      'https://system.easypractice.net/api/v1/services?order_by_name=asc&page_size=100',
      { method: 'GET', headers },
    );

    if (!servicesRes.ok) {
      return res
        .status(servicesRes.status)
        .json({ error: 'Failed to fetch services' });
    }

    const services = await servicesRes.json();

    return res.status(200).json(services);
  } catch (error) {
    return res
      .status(500)
      .json({ error: 'Unexpected error', detail: error.message });
  }
}
