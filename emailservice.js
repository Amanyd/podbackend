const axios = require("axios");

async function sendEmail(userEmail, summaries) {
  const html = summaries.map(s => `
    <p><a href="${s.url}">${s.url}</a></p>
    <p>${s.summary}</p>
    <audio controls src="${s.audioLink}"></audio>
  `).join("<hr>");

  await axios.post("https://api.brevo.com/v3/smtp/email", {
    sender: { 
      name: "Bookmark Bot", 
      email: process.env.EMAIL_FROM 
    },
    to: [{ email: userEmail }],
    subject: "Your Bookmark Podcast is Ready 🎧",
    htmlContent: html
  }, {
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json"
    }
  });
}

module.exports = { sendEmail };
