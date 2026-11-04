# TeamTrack

Task, ticket, goal and whiteboard tracker for small teams. MERN + TypeScript monorepo.

```
packages/shared   zod schemas, enums, DTO types (used by server and web)
apps/server       Express 5 + Mongoose API, outbox worker, migrations
apps/web          React 19 + Vite + Tailwind, minimal UI
```

## Run it

**No database needed (quickest):**

```bash
npm install
npm run dev:memory        # in-memory MongoDB + demo data, API :4000, web :5173
```

Sign in at http://localhost:5173 as `owner@demo.test` / `password1234` (also `admin@`, `manager@`, `member@`). Data resets on exit.
The demo project WEB has a task waiting in **Testing** for `admin@demo.test`.

**Against the real database (shared `apps/.env`):**

```bash
npm run db:check -w @teamtrack/server    # read-only: ping + list collections
npm run db:migrate                       # creates tt_* collections, validators, indexes
npm run dev
```

Config: `apps/server/.env` (see `.env.example`). Mongo and AWS come from `apps/.env`. Only the `MONGODB_*`, `AWS_*` and `S3_UPLOAD_PREFIX` keys are read from that file. Every collection is prefixed `tt_` so the database can be shared with other apps.

## Checks

```bash
npm run typecheck && npm run lint && npm test
```

Server tests run against an in-memory MongoDB **replica set**, so transactions are tested for real.

## Deploy (Render)

One web service runs the API and serves the web app from the same origin (`Dockerfile.render`, `render.yaml`).

1. Push this folder to its own GitHub repo.
2. In Render: **New > Blueprint**, pick the repo. Fill in the values marked "sync: false":
   - `CLIENT_URL`: the service URL, e.g. `https://teamtrack.onrender.com`
   - `MONGODB_URI`, `MONGODB_DB_NAME`: the Atlas cluster and database name
   - `AWS_*`, `S3_UPLOAD_PREFIX`: the S3 bucket
   - `SMTP_USER`, `SMTP_PASS` (a Gmail app password), `MAIL_FROM`
3. Each deploy runs migrations first (`preDeployCommand`), then switches traffic once `/readyz` is healthy.
4. Sign up to create the workspace, invite everyone, then set `ALLOW_WORKSPACE_SIGNUP=false`.

In production the server refuses to boot when any of these is true:
- `CLIENT_URL` or `TRUST_PROXY` is missing
- storage would be in memory
- `MAIL_REDIRECT_TO` is set

## Engineering notes

- **Layering:** route, controller (HTTP only), service (rules + transactions), repository (only code touching models).
- **Tenant isolation:** every tenant-scoped query must include `workspaceId`; a schema hook throws if one doesn't.
- **Optimistic concurrency:** versioned writes need `If-Match: "<version>"`; stale writes get `409 STALE_VERSION`.
- **Outbox:** notifications and emails are written in the same transaction as the change and delivered by a worker with retry and backoff. Every step is idempotent on the dedupe key.
- **Notifications:** a `notify` outbox message stores the in-app notification, pushes it over Socket.io to the recipient, then queues the email if their preferences (Settings > Email notifications) allow. Nobody is notified about their own action.
- **Live updates:** Socket.io on `/socket.io`, authenticated with the access token (the socket closes when the token expires and the client reconnects with a fresh one). Events carry ids only; clients refetch through the REST API. The tab that made a change is skipped via `X-Socket-Id`. One instance keeps rooms in memory; add a shared adapter before running several.
- **Scheduler:** jobs take a lease in `tt_jobLocks`, so only one instance runs each. `due-reminders` (every 15 min, 09:00 to 20:00 workspace time) sends one "due soon" and one "overdue" notice per due date.
- **Email:** Gmail SMTP as narenyashwanth760@gmail.com; `SMTP_PASS` must be a Gmail app password. `MAIL_REDIRECT_TO` (dev only, rejected in production) sends every email to one inbox.
- **Auth:** 15-min access JWT in memory; rotating refresh token in an httpOnly cookie with reuse detection; CSRF double-submit; argon2id; lockout after 5 failures.
- **Idempotency:** the web client sends an `Idempotency-Key` with every POST; a retried request replays the first 2xx response instead of creating a duplicate (keys live 24h in `tt_idempotencyKeys`).
- **Errors:** every error is RFC 7807 `application/problem+json` with a `requestId`.
- **Testing step:** sending a task to a Testing column requires a tester other than the assignee; only the tester (or a lead/admin) can pass (to Done) or fail (back) it. Each trip is a numbered round; tester and assignee are emailed.
- **Ordering:** Kanban positions are fractional string ranks set from neighbour ids (never client ranks); a column is re-spaced in the same transaction if ranks grow long.
- **Migrations own the schema:** `autoIndex`/`autoCreate` are off; `db:migrate` creates collections with `$jsonSchema` validators and syncs indexes.

## Roadmap

1. ~~Foundation: auth, invites, users, roles, projects~~
2. ~~Tasks + Kanban, subtasks, checklists, labels, Testing step~~
3. ~~Email + in-app notifications, Socket.io live updates, due-date reminders~~
4. ~~Tickets~~
5. ~~Comments + @mentions, image/file attachments, activity log~~
6. ~~Daily / weekly / monthly goals~~
7. ~~Excalidraw whiteboards (realtime)~~
8. ~~Calendar, standups, search~~
9. ~~Dashboard & reports~~
10. Hardening + deploy: done except the items in [DOUBTS.md](DOUBTS.md) (purge job, OpenAPI, Playwright E2E, real deploy target)
