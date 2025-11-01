const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

// Pfad zu deiner credentials.json
const CREDENTIALS_PATH = "./credentials.json";
const TOKEN_PATH = "./token.json";

// Diese Scopes erlauben Senden & Lesen über Gmail
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

async function authorize() {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const credentials = JSON.parse(content);

  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Falls bereits ein Token existiert, abbrechen
  if (fs.existsSync(TOKEN_PATH)) {
    console.log("✅ Bereits autorisiert – token.json existiert.");
    return;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log("👉 Öffne diesen Link in deinem Browser:");
  console.log(authUrl);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("\n📋 Füge hier den Code von Google ein: ", async (code) => {
    rl.close();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log("✅ Token gespeichert in", TOKEN_PATH);
  });
}

authorize().catch(console.error);