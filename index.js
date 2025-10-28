const express = require("express");
const calendarRoutes = require("./calendar");
const cors = require("cors");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");
const { DateTime } = require("luxon");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 30 }));

// =============== FILE FALLBACK (optional) ===============
const dataDir = path.join(__dirname, "data");
const file = path.join(dataDir, "appointments.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");

const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// ==========================================================
// Google Auth Helper
function getGoogleClient() {
  return new GoogleAuth({
    credentials: {
      client_email: process.env.GCAL_CLIENT_EMAIL,
      private_key: (process.env.GCAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

// ==========================================================
// Resend Mail
async function sendMail({ to, subject, text, ics }) {
  const body = {
    from: `${process.env.SHOP_NAME} <${process.env.SHOP_EMAIL}>`,
    to,
    subject,
    text,
  };

  if (ics) {
    body.attachments = [
      {
        filename: "termin.ics",
        content: Buffer.from(ics).toString("base64"),
      },
    ];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "E-Mail-Versand fehlgeschlagen");
  console.log("📤 Mail gesendet an", to);
}

// ==========================================================
// ICS-Datei Builder
function buildICS({ summary, description, start, end, uid }) {
  const s = DateTime.fromISO(start).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const e = DateTime.fromISO(end).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const now = DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${s}`,
    `DTEND:${e}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description.replace(/\n/g, "\\n")}`,
    `ORGANIZER;CN="${process.env.SHOP_NAME}":mailto:${process.env.SHOP_EMAIL}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// ==========================================================
// Event zu Google Calendar hinzufügen
async function addToCalendar({ summary, description, start, end, email }) {
  if (!process.env.GCAL_CALENDAR_ID) return null;

  const auth = getGoogleClient();
  const calendar = google.calendar("v3");
  const client = await auth.getClient();

  const response = await calendar.events.insert({
    auth: client,
    calendarId: process.env.GCAL_CALENDAR_ID,
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      start: { dateTime: start },
      end: { dateTime: end },
      attendees: [{ email }],
    },
  });

  console.log("📅 Neuer Google Calendar Eintrag erstellt:", response.data.id);
  return response.data.id;
}

// ==========================================================
// Default Route
app.get("/", (_, res) => res.send("✅ Werkstatt Backend läuft (Google Sync)"));

// ==========================================================
// POST: Neuer Termin
app.post("/api/appointments", async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.email || !b.start_iso || !b.end_iso)
      return res.status(400).json({ error: "Pflichtfelder fehlen" });

    const id = `apt_${Date.now()}`;
    const summary = `Werkstatt: ${b.service || "Service"} – ${b.name}`;
    const description = `Kunde: ${b.name}\nE-Mail: ${b.email}\nTelefon: ${
      b.phone || "-"
    }\n\nNotizen: ${b.notes || "-"}`;

    const gcal_event_id = await addToCalendar({
      summary,
      description,
      start: b.start_iso,
      end: b.end_iso,
      email: process.env.SHOP_EMAIL,
    });

    // Optional JSON-Backup
    const all = read();
    all.push({ id, status: "pending", gcal_event_id, ...b });
    write(all);

    const ics = buildICS({
      summary,
      description,
      start: b.start_iso,
      end: b.end_iso,
      uid: id,
    });

    await sendMail({
      to: b.email,
      subject: "Termin-Anfrage erhalten",
      text: `Hallo ${b.name},\n\nvielen Dank für Ihre Anfrage.\nIhr Terminwunsch: ${b.start_iso}\n\nWir melden uns zur Bestätigung.\n\nViele Grüße\n${process.env.SHOP_NAME}`,
      ics,
    });

    res.json({ success: true, gcal_event_id });
  } catch (err) {
    console.error("❌ Fehler beim Erstellen:", err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// 📅 ALLE TERMINE LADEN (GET)
// ========================================
app.get("/api/appointments", async (req, res) => {
  try {
    const auth = getGoogleClient();
    const calendar = google.calendar("v3");
    const client = await auth.getClient();

    const response = await calendar.events.list({
      auth: client,
      calendarId: process.env.GCAL_CALENDAR_ID,
      timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 100,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (response.data.items || []).map((e) => {
      const attendees = e.attendees || [];
      // 👇 Wir prüfen, was der Shop (Admin) geantwortet hat
      const shopAttendee = attendees.find(
        (a) => a.email === process.env.SHOP_EMAIL
      );
      const attendeeStatus = shopAttendee?.responseStatus || "needsAction";

      return {
        id: e.id,
        summary: e.summary || "Unbenannter Termin",
        description: e.description || "-",
        start_iso: e.start?.dateTime || e.start?.date,
        end_iso: e.end?.dateTime || e.end?.date,
        attendees: attendees.map((a) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })),
        // 👇 Das ist der angezeigte Status im Frontend
        status: attendeeStatus, // accepted | declined | tentative | needsAction
      };
    });

    res.json({ success: true, events });
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Termine:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================================
// DELETE: Termin löschen (Google Calendar + JSON)
app.delete("/api/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const auth = getGoogleClient();
    const calendar = google.calendar("v3");
    const client = await auth.getClient();

    await calendar.events.delete({
      auth: client,
      calendarId: process.env.GCAL_CALENDAR_ID,
      eventId: id,
      sendUpdates: "all",
    });

    const all = read().filter((a) => a.gcal_event_id !== id);
    write(all);

    console.log("🗑️ Termin aus Google Calendar gelöscht:", id);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fehler beim Löschen:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================================
// PATCH: Status ändern
app.patch("/api/appointments/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!id || !status)
      return res
        .status(400)
        .json({ success: false, message: "Fehlende Parameter" });

    const auth = getGoogleClient();
    const calendar = google.calendar("v3");
    const client = await auth.getClient();

    const event = await calendar.events.get({
      auth: client,
      calendarId: process.env.GCAL_CALENDAR_ID,
      eventId: id,
    });

    const attendees = event.data.attendees || [];
    const updated = attendees.map((a) =>
      a.email === process.env.SHOP_EMAIL ? { ...a, responseStatus: status } : a
    );

    await calendar.events.patch({
      auth: client,
      calendarId: process.env.GCAL_CALENDAR_ID,
      eventId: id,
      sendUpdates: "all",
      requestBody: { attendees: updated },
    });

    console.log(`✅ Terminstatus geändert: ${id} → ${status}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fehler beim Status-Update:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================================
app.use("/api/calendar", calendarRoutes);

// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
