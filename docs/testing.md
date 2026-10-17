# Testing

`npm test` runs every suite in `__tests__/`. Most need nothing but Node. The
suites named `*.db.test.ts` drive the app's own route handlers against a real
Postgres, because what they check (transactions, row order, unique
constraints, the OAuth token rules) cannot be faked faithfully. Without a
database they are **skipped**, and a skipped suite proves nothing, so run them
before you push.

## Running the database suites

Start a disposable Postgres and point `TEST_DATABASE_URL` at it:

```bash
docker run --rm -d --name openreply-test-postgres -p 55439:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:16
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55439/postgres
npm test
```

Each suite builds its schema from `prisma/migrations`, the way
`prisma migrate deploy` does, inside a throwaway Postgres schema of its own and
drops it at the end. Suites can run side by side against one server, and the
database never holds anything worth keeping.

Set `REQUIRE_TEST_DATABASE=1` to turn a missing `TEST_DATABASE_URL` into a
failure instead of a skip, for example in a pre-push hook.

## What the suites fake

Only two things:

- **Instagram**, at `fetch`, where `lib/meta/client.ts` reaches the Graph API
  (`__tests__/support/instagram.ts`). It keeps each account's conversations and
  posts, checks access tokens the way Instagram does, and records sends. Tests
  never send a real DM, and any request it does not recognise fails the test.
- **The signed-in user**, at `@/lib/auth` (`__tests__/support/session.ts`).
  The workspace-access rules built on it stay real.

Everything else is real, including Postgres (`__tests__/support/database.ts`)
and the seed helpers in `__tests__/support/fixtures.ts`.
