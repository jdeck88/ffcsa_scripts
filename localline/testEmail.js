// File: testEmail.js
require('dotenv').config(); // Loads environment variables
const { sendEmail } = require('./utilities'); // Adjust path if needed

// Compose the test email options
const emailOptions = {
  from: 'fullfarmcsa@deckfamilyfarm.com', // Must be a verified sender in SendGrid
  to: 'jdeck88@gmail.com', // Change to your recipient address
  subject: 'Test Email from Node.js using SendGrid',
  text: 'Hello! This is a test email sent from your Node.js script using SendGrid over port 2525.',
  html: '<p><strong>Hello!</strong> This is a <em>test email</em> sent from your Node.js script using <code>SendGrid</code>.</p>',
};

// Send the email
sendEmail(emailOptions);

