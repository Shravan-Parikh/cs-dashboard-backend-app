# CS Dashboard — API

Node + Express API behind [CS Dashboard](https://github.com/Shravan-Parikh/cs-dashboard-frontend-app),
a workspace for Company Secretaries in India. Serves BSE corporate filings and
runs auth + persistence on Firebase.

## Run locally

```bash
cp .env.example .env    # fill in the Firebase values
npm install
npm run dev             # http://localhost:4000
```

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `FIREBASE_API_KEY` | ✅ | Firebase **web** API key. Public by design — access is governed by Firestore rules, not this key. |
| `FIREBASE_PROJECT_ID` | ✅ | Firebase project id. |
| `PORT` | — | Defaults to 4000. Cloud Run injects 8080. |
| `CORS_ORIGIN` | — | Comma-separated allowed origins. Supports one `*` label, e.g. `https://*.vercel.app`. |
| `ALLOW_PUBLIC_SIGNUP` | — | `false` during the pilot; accounts are provisioned. |
| `ADMIN_EMAILS` | — | Comma-separated emails that get the `admin` role. |

The server **refuses to boot** without the two Firebase values, so a misconfigured
deploy fails loudly instead of silently serving broken auth.

## Deploy to Cloud Run

The `Dockerfile` at the repo root is all Cloud Run needs.

1. Cloud Run → **Create service** → *Continuously deploy from a repository*.
2. Connect this GitHub repo, branch `main`, build type **Dockerfile**.
3. Set the environment variables above under *Variables & Secrets*.
   `CORS_ORIGIN` must include the Vercel frontend URL.
4. Allow unauthenticated invocations — the API does its own token auth, and the
   browser calls it directly.

Cloud Run terminates TLS and injects `PORT`; the app binds it automatically.
Do not add `.env` to the image — `.dockerignore` deliberately excludes it.

After the first deploy, point the frontend's `NEXT_PUBLIC_API_BASE` at
`https://<service-url>/api`.

## Accounts

Sign-ups are closed during the pilot. Create accounts from a terminal with the
`.env` in place:

```bash
node scripts/create-user.js "Full Name" person@firm.com
```

It prints a generated password. Emails in `ADMIN_EMAILS` become admins, which
unlocks `GET|POST /api/auth/admin/users` and `GET /api/admin/activity`.

## Firebase

Talks to Firebase over its **REST APIs** (`src/firebase.js`) rather than
`firebase-admin`, so there's no service-account key to provision or leak.
Firestore calls carry the signed-in user's ID token, so security rules genuinely
apply; ID tokens are verified locally against Google's rotating public certs, so
auth costs no network round-trip per request. Tokens last an hour and the
frontend refreshes them transparently.

Collections are all prefixed `cs_` so a shared Firebase project is untouched:

| Collection | Purpose |
| --- | --- |
| `cs_users/{uid}` | profile + role |
| `cs_watchlists/{uid}` | companies a user tracks |
| `cs_saved_views/{uid}` | saved filter presets |
| `cs_activity/{id}` | usage log — what the pilot actually uses |

> **Security rules** live in `firestore.rules` in the monorepo and are a
> *fragment to merge*, not a ruleset to publish — Firestore rules are
> project-wide and publishing replaces everything.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/login` · `/refresh` · `GET /me` | — / token | Session |
| `GET /api/announcements/latest` | token | Market-wide CS-relevant feed |
| `POST /api/announcements` | token | Company/index search over a date range |
| `GET /api/company/:scrip` | token | Company 360 timeline |
| `GET /api/compliance` | token | Statutory due dates |
| `GET|PUT /api/workspace/watchlist` | token | Persisted watchlist |
| `GET|POST|DELETE /api/workspace/views` | token | Saved views |
| `GET /api/pdf?url=` | public | Proxies BSE PDFs (validated BSE URLs only) |
| `POST /api/export/zip` | token | Bundles filing PDFs |

## The BSE API, as actually observed

BSE's endpoint is undocumented and its limits are not what you'd guess — read
the notes in `src/bseClient.js` before changing transport behaviour. In short:
single-scrip queries have no date-span limit, market-wide with `strCat=-1` is
capped at **one day**, and market-wide with a named category at **~30 days**.
The cap is volume-independent, so ranges are chunked at 25 days. Some BSE
responses carry malformed HTTP headers that Node's `fetch` rejects outright;
`bseGet()` falls back to `node:https` with `insecureHTTPParser` for those.
