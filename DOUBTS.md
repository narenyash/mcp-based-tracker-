# Open questions from the overnight run (2026-11-03)

Phases 4 to 9 are built, and phase 10 is done apart from the items below.
`npm run lint`, `npm run typecheck`, `npm test` (167 tests) and `npm run build` all pass.
The in-memory dev stack boots, and the new endpoints return 200 on seeded data.

**Nothing has been tried in a browser yet.** First thing to do: run `npm run dev:memory` and click through Tickets, Goals, Whiteboards, Reports and the task drawer (comments and attachments). Use two browsers for whiteboard live sync.

Nothing was committed. The git repo root is `C:\naren yashwanth N`, and this folder is still untracked there.

Answer inline (e.g. "1: yes") and we'll go through them.

---

## Needs your decision (blocking or risky)

1. **`db:migrate` against the real `wmsnk` database.** It has never been run there (you haven't OK'd it yet). It would now create migrations 0001 to 0010, all `tt_*` collections (0010 adds `tt_snakeScores` for the home-page Snake leaderboard). Run it?
2. **Purge job for soft-deleted data (plan §3.3, "hard-delete after 30 days + remove S3 objects").** Not built on purpose. It permanently deletes data in a shared DB, and it needs rules for orphaned comments, attachments and activity, and for goal/ticket links to purged tasks. Build it? Should it be off by default behind an env flag? Which entities: tasks, tickets, boards (and snapshots), comments, attachments, projects? Users should probably be anonymised, not deleted.
3. **dev:memory uses your real S3 bucket.** If `AWS_BUCKET_NAME` is set in `apps/.env`, even `npm run dev:memory` stores uploads and whiteboard scenes in the real bucket (under `<S3_UPLOAD_PREFIX>/teamtrack/`). This was already the case before tonight. Should dev:memory force `STORAGE_DRIVER=memory`?
4. **Not built from phase 10:** OpenAPI/Swagger (`zod-to-openapi`), Playwright E2E, web unit tests (Vitest + RTL), and a k6 load script. Each needs new dependencies (Playwright also downloads browsers), so I didn't add them unattended. Which do you want?
5. **Deploy target.** The plan says frontend on Vercel or S3+CloudFront and server on Render or EC2. The Dockerfiles, nginx config and CI exist, but nothing is deployed and CI doesn't push images. Where should it go?

## Reports and dashboard (phase 9)

6. Should managers see reports for **private projects they aren't members of**? Currently they don't; it follows the existing project-visibility rule.
7. Members get a **"my own work"** version of Reports rather than a 403. OK?
8. The team route is **`/api/v1/reports/team`**, not the plan's `/dashboard/team`. OK?
9. Should tasks in **archived projects** be dropped from open and overdue counts? Currently they count.
10. **Cycle time** is creation → done, and **testing first-pass rate** uses each task's latest test round. True cycle time and per-round history need a status-history log in the tasks module. Want it?
11. For a large workspace, reports would want new indexes: tasks `{workspaceId, completedAt}`, and tickets `{workspaceId, createdAt}` and `{workspaceId, resolvedAt}`. Fine at your team size. Add them now?

## Comments, attachments, tickets (phases 4 and 5)

12. Live comment updates go to **project rooms** only. Boards always have a project (the board page now joins its room), but **goal comments** with no project won't update live. Add per-entity rooms on the server?
13. There's **no socket event for attachments or activity**, so other people's uploads show up within about 4 minutes or on reopen. Add an `attachment:changed` event?
14. **Mentions:** if two people with the same display name are mentioned in one draft, both resolve to whoever was picked last. Acceptable for now?
15. The workspace Tickets list has **no status filter**, because statuses are per project. Add it when a single project is selected?

## Goals (phase 6)

16. The task drawer **doesn't show or set a task's goal**. There's no API for "goals linking this task". Add a `taskId` filter to `GET /goals` and a goal field in the drawer?
17. The manager's person dropdown on Goals lists only people who already have goals that period. Should it list all members?
18. **Carry over** appears only once a goal's period has ended (or it's missed), though the server allows it mid-period. Show it earlier?
19. "This week" highlighting uses the **browser's** date, not the workspace timezone, so it can be off by a day around midnight. The data itself is always correct.

## Whiteboards (phase 7)

20. Viewers who can't edit a board **also can't comment** on it, because the server uses `canEdit` for comment permission. Intended?
21. Presence appears **twice**: header avatars plus Excalidraw's own collaborator list. Keep both?
22. Add a small `board:saved {sceneVersion}` server event? Without it, the next save after someone else's takes an extra 409 → refetch → retry round trip. It works as is.
23. Restoring a version uses the browser's `confirm()`. Switch it to an in-app dialog?

## Small things fixed tonight (FYI)

- **Lint:** `collab/fileTypes.ts` had a literal BOM character in a regex. It's now `\uFEFF`.
- **Goals test:** it depended on the date and broke once week 44 ended. It now uses the current week.
- **Ticket live updates:** they now refresh on every page (moved into `lib/realtime.ts`), not only on the Tickets page.
- **Project page:** now links to its Tickets board and Whiteboards.
- **New: `Idempotency-Key` support.** A double-clicked or retried POST creates one record (migration `0009-idempotency`, collection `tt_idempotencyKeys`, 6 tests).
