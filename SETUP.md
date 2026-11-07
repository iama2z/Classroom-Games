# Shared teacher access

The website and `Code.gs` must be updated together. Do not publish the new website before updating the Google deployment: the old script does not authenticate teachers.

## Update your existing spreadsheet

1. Keep the spreadsheet private. Students need the game link, not spreadsheet access.
2. Open **Extensions → Apps Script**. Replace `Code.gs` with this repository's `Code.gs` and save. Do not delete script properties; these hold your existing rooms.
3. Select **setupTeacherSettings** in the function dropdown and click **Run**. Approve Google's authorization prompt.
4. Return to the spreadsheet. In the new **TeacherSettings** tab, enter a passphrase of 12–256 characters in **B2**. Use a long, unique passphrase. Do not put it in GitHub, a chat message, or a student link.
5. In Apps Script, choose **Deploy → Manage deployments → Edit** for your existing web app. Select **New version**, then **Deploy**. Keep **Execute as: Me** and **Access: Anyone** so students can join without Google accounts. The URL stays the same.
6. Delete other obsolete web-app deployments that still accept unauthenticated writes. Hiding a spreadsheet tab does not secure an old deployment.
7. After the website is published, open **Teacher Dashboard** and enter the shared passphrase. Check another device: it should require the same passphrase and already know the spreadsheet URL.

`TeacherSettings!B2` is deliberately readable by spreadsheet editors. Restrict spreadsheet access accordingly. Changing B2 invalidates all teacher sessions immediately on their next server request. Sessions also expire after at most one hour; refreshing or signing out removes the website's in-memory session. There is no default `1234` login and the old browser-only PIN is not used.

The public website URL is not a secret. The passphrase is sent only in HTTPS POST requests and is never included in QR codes or saved game snapshots. Apps Script authenticates teacher writes and filters students' state to avoid exposing other players' secret roles or device tokens. Five incorrect login attempts trigger a shared one-minute cooldown; this is not protection against all denial-of-service attacks or Apps Script quota exhaustion.

## Student QR code

In the teacher dashboard, use **Student QR** or **Show student QR code**. The QR encodes the selected room's student-only link and spreadsheet connection. Students scan it and enter their name. QR generation runs locally using the bundled MIT-licensed `qrcode-generator` library; no QR service receives the link.

## Development

Run `npm ci`, `npm run build`, and `npm test`. Edit the server in `Code.gs`; the build embeds it into the setup modal, synchronizes both HTML entry points, and copies the QR library into `vendor/`. The generated files are committed so GitHub Pages needs no Node build step.
