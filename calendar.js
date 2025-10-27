// calendar.js
const express = require("express");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const router = express.Router();

function getGoogleClient() {
  return new GoogleAuth({
    credentials: {
      client_email: process.env.GCAL_CLIENT_EMAIL,
      private_key: (process.env.GCAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });
}

router.get("/events", async (_req, res) => {
  try {
    const auth = getGoogleClient();
    const calendar = google.calendar("v3");
    const client = await auth.getClient();

    const response = await calendar.events.list({
      auth: client,
      calendarId: process.env.GCAL_CALENDAR_ID,
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];

    const blockedSlots = events
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }));

    res.json({ success: true, events, blockedSlots });
  } catch (error) {
    console.error("❌ Fehler /api/calendar/events:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
