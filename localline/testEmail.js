// File: testEmail.js
require('dotenv').config(); // Loads environment variables
const { sendEmail } = require('./utilities'); // Adjust path if needed

// Compose the test email options
const emailOptions = {
  to: 'jdeck88@gmail.com', // Change to your recipient address
  subject: 'FFCSA Reports: SMTP Test',
  text: 'This is a test email from the FFCSA reporting scripts.',
};

// Send the email
sendEmail(emailOptions);

