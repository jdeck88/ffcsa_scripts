const fs = require('fs');
const path = require('path');
require('dotenv').config();
const utilities = require('./utilities');

const DAYS = [
  { name: 'Monday', field: 'repeat_on_monday' },
  { name: 'Tuesday', field: 'repeat_on_tuesday' },
  { name: 'Wednesday', field: 'repeat_on_wednesday' },
  { name: 'Thursday', field: 'repeat_on_thursday' },
  { name: 'Friday', field: 'repeat_on_friday' },
  { name: 'Saturday', field: 'repeat_on_saturday' },
  { name: 'Sunday', field: 'repeat_on_sunday' },
];

const JS_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const EXCLUDED_NAME_PATTERNS = [
  'membership',
  'herdshare',
];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDateDayName(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) {
    return null;
  }

  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return JS_DAY_NAMES[date.getDay()] || null;
}

function getDeliveryDays(availability = {}) {
  const repeatDays = DAYS
    .filter((day) => availability[day.field] === true)
    .map((day) => day.name);

  if (repeatDays.length > 0) {
    return repeatDays;
  }

  const availableDates = Array.isArray(availability.available_dates)
    ? availability.available_dates
    : [];
  const customDateDays = availableDates
    .map((entry) => parseDateDayName(entry.available_date))
    .filter(Boolean);

  return DAYS
    .map((day) => day.name)
    .filter((day) => customDateDays.includes(day));
}

function formatTimeSlots(availability = {}) {
  const timeSlots = Array.isArray(availability.time_slots)
    ? availability.time_slots
    : [];

  if (timeSlots.length === 0) {
    return 'No time slots';
  }

  return timeSlots
    .map((slot) => `${slot.start} - ${slot.end}`)
    .join(', ');
}

function shouldIncludeLocation(location) {
  const normalizedName = String(location.name || '').toLowerCase();
  return (
    location.active === true &&
    location.address &&
    location.address.latitude !== null &&
    location.address.latitude !== undefined &&
    location.address.longitude !== null &&
    location.address.longitude !== undefined &&
    !EXCLUDED_NAME_PATTERNS.some((pattern) => normalizedName.includes(pattern))
  );
}

function formatLocation(location) {
  const availability = location.availability || {};
  return {
    name: location.name,
    days: getDeliveryDays(availability),
    address: location.address.formatted_address || 'Address not available',
    time: formatTimeSlots(availability),
    latitude: location.address.latitude,
    longitude: location.address.longitude,
  };
}

async function fetchFulfillmentStrategies(accessToken) {
  let url = 'https://localline.ca/api/backoffice/v2/fulfillment-strategies/';
  const results = [];

  while (url) {
    const response = await utilities.getJsonFromUrl(url, accessToken);
    results.push(...(response.results || []));
    url = response.next || null;
  }

  return results;
}

function buildDeliveryRows(strategies) {
  return strategies
    .filter(shouldIncludeLocation)
    .map(formatLocation)
    .filter((row) => row.days.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getOrderWindowText(day) {
  if (day === 'Tuesday' || day === 'Wednesday') {
    return ' (order window Thursday through Sunday)';
  }
  if (day === 'Friday' || day === 'Saturday') {
    return ' (order window Monday through Wednesday)';
  }
  return '';
}

function buildHtml(rows) {
  const tableSections = DAYS.map((day) => {
    const dayRows = rows
      .filter((row) => row.days.includes(day.name))
      .map((row) => `
                <tr>
                    <td>${escapeHtml(row.name)}</td>
                    <td>${escapeHtml(row.time)}</td>
                    <td>${escapeHtml(row.address)}</td>
                </tr>
            `)
      .join('');

    if (!dayRows) {
      return '';
    }

    return `
                <h2 style="margin-top: 20px;">${day.name} Dropsites${getOrderWindowText(day.name)}</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Time of Day</th>
                            <th>Address</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dayRows}
                    </tbody>
                </table>
            `;
  }).join('');

  return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dropsite Locations (Free delivery)</title>
            <style>
                @font-face {
                    font-family: 'Tomarik Introvert';
                    src: url('data:font/woff2;base64,<BASE64-FONT-DATA>') format('woff2');
                }
                body {
                    font-family: 'Tomarik Introvert', sans-serif;
                    margin: 20px;
                    padding: 0;
                    background-color: #f7f7f7;
                }
                h1, h2 {
                    text-align: center;
                    color: #333;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 20px 0;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 12px;
                    text-align: center;
                }
                th {
                    background-color: #f2f2f2;
                    color: #333;
                    font-weight: bold;
                }
                tr:nth-child(even) {
                    background-color: #fafafa;
                }
                tr:hover {
                    background-color: #f1f1f1;
                }
            </style>
        </head>
        <body>
            <h1>Home Delivery</h1>
            <p>There is a $20 fee for home delivery with free delivery for orders over $125. See map (above) for delivery area. Eugene/Springfield/Junction City deliveries happen on Tuesdays and Corvallis deliveries happen on Saturdays.</p>
            <h1>Drop Sites (Free)</h1>
            <p>Drop site locations and days are listed below. All dropsite deliveries are free. You can choose your preferred dropsite location when placing your order.</p>
            ${tableSections}
        </body>
        </html>`;
}

function buildTsv(rows) {
  const header = 'Name\tDay\tAddress\tTime\tLatitude\tLongitude\n';
  const body = rows
    .flatMap((row) => row.days.map((day) => [
      row.name,
      day,
      row.address,
      row.time,
      row.latitude,
      row.longitude,
    ].join('\t')))
    .join('\n');

  return `${header}${body}\n`;
}

async function run() {
  try {
    const tokenData = await utilities.getAccessToken();
    const accessToken = JSON.parse(tokenData).access;
    const strategies = await fetchFulfillmentStrategies(accessToken);
    const rows = buildDeliveryRows(strategies);

    if (rows.length === 0) {
      console.log('No valid records to write.');
      return;
    }

    const htmlPath = path.join(__dirname, '..', 'docs', 'delivery_data.html');
    const tsvPath = path.join(__dirname, 'data', 'delivery_data.tsv');

    fs.writeFileSync(htmlPath, buildHtml(rows), 'utf8');
    console.log(`HTML data written to ${htmlPath}`);

    fs.writeFileSync(tsvPath, buildTsv(rows), 'utf8');
    console.log(`TSV data written to ${tsvPath}`);
  } catch (error) {
    console.error('An error occurred:', error);
    if (utilities.sendErrorEmail) {
      utilities.sendErrorEmail(error);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  buildDeliveryRows,
  buildHtml,
  buildTsv,
  getDeliveryDays,
};
