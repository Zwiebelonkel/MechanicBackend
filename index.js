const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const { DateTime } = require("luxon");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Rate Limit (30 Requests / Minute)
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 30 }));

// Datei-Speicher (JSON)
const dataDir = path.join(__dirname, "data");
const file = path.join(dataDir, "appointments.json");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");

const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// Mail Setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendMail({ to, subject, text, ics }) {
  const from = `"${process.env.SHOP_NAME}" <${process.env.SHOP_EMAIL}>`;
  const msg = { from, to, subject, text };
  if (ics) {
    msg.alternatives = [
      { contentType: "text/calendar; method=REQUEST", content: ics },
    ];
    msg.attachments = [
      { filename: "termin.ics", content: ics, contentType: "text/calendar" },
    ];
  }
  return transporter.sendMail(msg);
}

// ICS Datei (Fallback für Apple/Outlook)
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

// Google Calendar Integration
async function addToCalendar({ summary, description, start, end }) {
  if (!process.env.GCAL_CALENDAR_ID) return;
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GCAL_CLIENT_EMAIL,
      private_key: (process.env.GCAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  const calendar = google.calendar("v3");
  const client = await auth.getClient();
  await calendar.events.insert({
    auth: client,
    calendarId: process.env.GCAL_CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: start },
      end: { dateTime: end },
    },
  });
}

app.get("/", (_, res) => res.send("✅ Werkstatt Backend läuft!"));

// Termin-Endpoint
app.post("/api/appointments", async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.email || !b.start_iso || !b.end_iso)
      return res.status(400).json({ error: "Pflichtfelder fehlen" });

    const id = `apt_${Date.now()}`;
    const all = read();
    all.push({ id, ...b });
    write(all);

    const summary = `Werkstatt: ${b.service || "Service"} – ${b.name}`;
    const description = `Kunde: ${b.name}\nE-Mail: ${b.email}\nTelefon: ${
      b.phone || "-"
    }\nFahrzeug: ${b.car_make || ""} ${b.car_model || ""} (${
      b.license_plate || "-"
    })\n\nNotizen: ${b.notes || "-"}`;

    // Mail an Werkstatt
    await sendMail({
      to: process.env.SHOP_EMAIL,
      subject: `Neue Termin-Anfrage: ${b.name}`,
      text: `${summary}\n${description}\n\nZeitraum: ${b.start_iso} bis ${b.end_iso}`,
    });

    // ICS + Bestätigung an Kunde
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

    // Kalender-Eintrag
    await addToCalendar({
      summary,
      description,
      start: b.start_iso,
      end: b.end_iso,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
