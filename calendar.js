// calendar.js
const express = require("express");
const { google } = require("googleapis");

const router = express.Router(); // <--- WICHTIG: Router muss zuerst definiert werden!

router.get("/events", async (req, res) => {
  try {
    const auth = new google.auth.JWT(
      process.env.GCAL_CLIENT_EMAIL,
      null,
      process.env.GCAL_PRIVATE_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/calendar.readonly"]
    );

    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.list({
      calendarId: process.env.GCAL_CALENDAR_ID,
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];

    // ➕ Blockierte Slots extrahieren
    const blockedSlots = events
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        start: e.start.dateTime,
        end: e.end.dateTime,
      }));

    res.json({ success: true, events, blockedSlots });
  } catch (error) {
    console.error("❌ Fehler beim Abrufen der Termine:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router; // <--- Exportieren nicht vergessen
