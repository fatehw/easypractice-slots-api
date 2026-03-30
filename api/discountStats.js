import { sendJson } from './slots'; // Reuse sendJson function

// Get Airtable API Token and Base URL from environment variables
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_TOKEN;
const AIRTABLE_BASE_URL = process.env.AIRTABLE_BASE_URL; // Base URL should include the baseId and table name

// Create a new discount lead record in Airtable
async function createDiscountLead(email) {
  const headers = {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const data = {
    fields: {
      Email: email,
      'Discount Applied': true,
      'Applied At': new Date().toISOString(),
      Status: 'Applied',
      'Booked/Paid': false, // Default to false (not booked)
      'Discount Code Sent': false, // Default to false (not sent)
      'Booked At': null, // No booking yet
    },
  };

  const response = await fetch(
    `${AIRTABLE_BASE_URL}/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
    {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(data),
    },
  );

  const result = await response.json();

  if (!response.ok) {
    return { error: 'Failed to create discount lead', details: result };
  }

  return result;
}

// Fetch discount stats from Airtable
async function getDiscountStats() {
  const headers = {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(
    `${AIRTABLE_BASE_URL}/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
    {
      method: 'GET',
      headers: headers,
    },
  );

  const data = await response.json();

  if (!response.ok) {
    return {
      error: 'Failed to fetch discount stats from Airtable',
      details: data,
    };
  }

  // Count applicants and bookings
  let totalApplied = 0;
  let totalBooked = 0;

  data.records.forEach((record) => {
    if (record.fields['Discount Applied']) totalApplied++;
    if (record.fields['Booked/Paid']) totalBooked++;
  });

  return {
    totalApplied,
    totalBooked,
    remainingSlots: 30 - totalBooked, // Assume max slots are 30
    progressPercent: (totalBooked / 30) * 100, // Calculate progress as percentage
  };
}

// Endpoint handler
export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const stats = await getDiscountStats();

      if (stats.error) {
        return sendJson(res, 500, stats); // Error from Airtable fetch
      }

      return sendJson(res, 200, stats); // Successfully fetched stats
    } catch (error) {
      return sendJson(res, 500, {
        error: 'Internal server error',
        details: error.message,
      });
    }
  } else if (req.method === 'POST') {
    const { email } = req.body; // Assuming email is sent in the body

    if (!email) {
      return sendJson(res, 400, { error: 'Email is required' });
    }

    try {
      const lead = await createDiscountLead(email);

      if (lead.error) {
        return sendJson(res, 500, lead); // Error creating discount lead
      }

      return sendJson(res, 200, {
        message: 'Discount lead created successfully',
        lead,
      });
    } catch (error) {
      return sendJson(res, 500, {
        error: 'Error creating discount lead',
        details: error.message,
      });
    }
  } else {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }
}
