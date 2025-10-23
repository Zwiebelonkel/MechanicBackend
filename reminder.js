const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const { DateTime } = require("luxon");

dotenv.config();

const file = path.join(__dirname, "data", "appointments.json");
if (!fs.existsSync(file)) process.exit(0);

const list = JSON.parse(fs.readFileSync(file, "utf8"));
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

(async () => {
  const tz = process.env.TIMEZONE || "Europe/Berlin";
  const now = DateTime.now().setZone(tz);
  const reminderHrs = Number(process.env.REMINDER_HOURS_BEFORE || 24);

  for (const a of list) {
    const start = DateTime.fromISO(a.start_iso).setZone(tz);
    if (
      start.diff(now, "hours").hours > reminderHrs - 0.5 &&
      start.diff(now, "hours").hours < reminderHrs + 0.5
    ) {
      await transporter.sendMail({
        from: `"${process.env.SHOP_NAME}" <${process.env.SHOP_EMAIL}>`,
        to: a.email,
        subject: "Erinnerung an Ihren Werkstatttermin",
        text: `Hallo ${
          a.name
        },\n\nErinnerung an Ihren Werkstatttermin:\n📅 ${start.toFormat(
          "dd.LL.yyyy HH:mm"
        )}\n🔧 ${
          a.service || "Werkstatt-Service"
        }\n\nFalls Sie verhindert sind, geben Sie uns bitte kurz Bescheid.\n\nViele Grüße\n${
          process.env.SHOP_NAME
        }`,
      });
      console.log("Reminder gesendet an:", a.email);
    }
  }
})();
