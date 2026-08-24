# Hearth — setting it up

About 40 minutes, once. Nothing here costs anything.

Files: `Code.gs` (the bridge, lives in the Sheet) and `index.html`, `app.js`,
`sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png` (the app, lives on GitHub Pages).

---

## 1 — The household account

Create the new Google account you decided on. Before anything else:

- Both your phone numbers and both personal emails as recovery
- 2-step verification on, backup codes printed and put somewhere physical

Everything now depends on this login, so this is not the step to rush.

Stay signed into it for the rest of setup.

## 2 — The Sheet and the bridge

1. Sheets → blank spreadsheet → name it **Hearth household**
2. Extensions → Apps Script
3. Delete the sample code, paste all of `Code.gs`, save
4. Run `setup` — approve the permissions when asked. It builds the nine tabs
   and fills the dropdown vocabulary.
5. Run `makeTokens`, then View → Logs. Copy what it prints.

## 3 — Calendars

In Calendar, on the household account:

- The **Family** calendar already exists if you've made a Google family group.
  Share it to both your personal accounts with *Make changes to events*.
- Create a second calendar called **Household**. Share it to your two personal
  accounts only — this is where money and health go, so the girls don't see it.

For each, Settings → *Integrate calendar* → copy the **Calendar ID**.

Then each of you, on your own phone, opens Google Calendar → Settings → tap each
of the two calendars → set your own notifications. Do this once. Event reminders
set by the script only fire for the account that created them, which is why the
app writes a separate all-day event for the notice period instead.

## 4 — Drive folder

In Drive on the household account, create a folder **Hearth documents**.
Share it to both your personal accounts as Editor. Take the folder ID from the
address bar — the part after `/folders/`.

## 5 — Script properties

Apps Script → Project Settings → Script Properties. Add:

| Property | Value |
|---|---|
| `TOKENS` | `{"paste-token-1":"YourName","paste-token-2":"WifeName"}` |
| `CAL_HOUSEHOLD` | the Household calendar ID |
| `CAL_FAMILY` | the Family calendar ID |
| `DRIVE_FOLDER` | the folder ID |
| `ANTHROPIC_KEY` | optional — turns on the voice/text parsing |
| `PARSE_MODEL` | optional — defaults to `claude-haiku-4-5-20251001` |

Without `ANTHROPIC_KEY` everything still works; you just fill the forms in
yourself instead of dictating.

Then run `installWeeklySnapshot` once. Every Sunday it writes a plain JSON copy
of everything into Drive, readable in ten years with no app at all.

## 6 — Deploy

Deploy → New deployment → **Web app**:

- Execute as: **Me**
- Who has access: **Anyone**

Copy the `/exec` address.

> Every single time you change `Code.gs` afterwards: Deploy → Manage deployments
> → pencil → Version: **New version** → Deploy. Editing the code alone does
> nothing. This is the one that bites everybody, every time.

## 7 — Host the app

New GitHub repo, e.g. `hearth`. Upload `index.html`, `app.js`, `sw.js`,
`manifest.json`, `icon-192.png`, `icon-512.png` to the root. Settings → Pages →
source `main`, folder `/ (root)`. You get `https://you.github.io/hearth/` in a
minute or two.

Public repo means the code is public. That's fine — it holds no data and no
secrets. Both the token and the address are typed into the app on the phone.

## 8 — On both phones

Open the Pages address in Chrome → menu → **Add to Home screen**. Open it from
the home screen, and give it:

- the `/exec` address
- that person's own token

Once each. Never type either into the address bar — that's what caused the grief
last time, because Chrome remembers addresses.

## 9 — First ten minutes of use

1. **Things** → add the car, the house, and each of the four of you
2. **+** → add three or four real obligations. If parsing is on, just say them:
   *"car insurance renews 14th March, Admiral, six hundred and twenty pounds,
   remind me a month before"*
3. Check the two calendars — you should see the due date and a heads-up entry
   thirty days earlier
4. Open one and tap **Mark paid**. The date advances, the payment is recorded,
   the calendar moves.

---

## How it behaves

- **Offline**: everything you type is written to the phone first and queued. The
  header shows how many are waiting. They leave when there's signal.
- **Two of you**: the bridge runs as the household account whatever phone it came
  from, so neither of you needs Google permissions. The `who` column records who
  did what, from the token.
- **Payments are append-only.** A correction is a new row, never an edit. The
  history is the audit trail.
- **Stale code**: the service worker asks the network for the app before falling
  back to the copy on the phone, and the version sits in the header, so you can
  always see what you're running.

## What it deliberately doesn't do

- **Push notifications.** Calendar does the reminding; both your phones already
  handle that properly, offline, with snooze.
- **Speech recognition.** Gboard's microphone already types into every box, in
  Hindi or English. The app only parses the words afterwards.
- **Store account numbers, card numbers or PINs.** Use a reference like
  "Barclays joint — 4471". The field is labelled that way on purpose.

## When something breaks

| What you see | What it is |
|---|---|
| "Token not recognised" | `TOKENS` isn't valid JSON, or you deployed before saving it |
| Changes don't appear | You deployed an old version. Manage deployments → New version |
| "The bridge refused that" | Open the Apps Script **Executions** tab; the error is there |
| Rows but no calendar entries | `CAL_HOUSEHOLD` / `CAL_FAMILY` wrong, or the calendar isn't on the household account |
| Uploads fail | `DRIVE_FOLDER` wrong, or you're offline — uploads are the one thing that needs signal |

OCR needs the **Drive API** advanced service switched on in the Apps Script
editor (Services → +  → Drive API). Without it, documents still upload; the text
just isn't extracted.
