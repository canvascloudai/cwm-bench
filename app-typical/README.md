# Typical profile

RealWorld ("Conduit") shaped reference service used when Terraform `app_profile=typical`. It is a separate package from `app/`, which stays the lean campaign. Node **20**, Express 4.21.2, mysql2 3.14.1, bcryptjs 2.4.3.

The primary process does not serve. It forks `APP_WORKERS` workers (default 1, campaign uses 2). Each worker's mysql2 `connectionLimit` is `floor(APP_POOL_SIZE / APP_WORKERS)`. `queueLimit` is `APP_QUEUE_LIMIT` on every worker (default 50). A crashed worker is respawned and the restart is counted.

`/api/meta` reports `service`, `profile` (`typical`), `workers`, `poolSize` (the per-server pool, so the adapter's pool check still sees 250), `poolSizePerWorker`, `queueLimit`, `gitSha`, and `node`.

## Auth

Every workload request, including `POST /api/users/login`, sends `Authorization: Token <jwt>`. The app splits the token, recomputes HMAC-SHA256 with `node:crypto`, compares with `timingSafeEqual`, parses the payload, and checks `exp`. There is no database lookup for auth. A bad token is HTTP 401, class `internal`.

The signing key `cwm-bench-typical-hs256-key` is a public benchmark constant, not a secret. Load-script tokens use `iat` 1767225600 and `exp` 4102444800. `/health` and `/api/meta` stay unauthenticated so the ALB and the worker adapter can call them.

## Endpoints

| Share | Method and path | SQL statements |
| ---: | --- | ---: |
| 59% | `GET /api/articles?limit=20&offset=O` | 3 |
| 20% | `GET /api/articles/:slug` | 3 |
| 10% | `GET /api/profiles/:username` | 2 |
| 10% | `POST /api/articles/:slug/comments` | 2, one transaction |
| 1% | `POST /api/users/login` | 1, plus a bcrypt compare |

List pages use `offset = 20 * U` with `U` in 0..49, ordered by `created_at DESC, id DESC`. The article page includes the full body and the 5 oldest comments (`ORDER BY id ASC LIMIT 5`). Comment posts validate a string body of 1 to 1,000 characters. Login looks up the user by email and compares the public password `cwm-bench-password` with bcryptjs at cost 10.

Errors keep the lean JSON contract and the same five classes.

## Dataset

`seed/seed-typical.sql` is deterministic SQL: no `RAND()`, `NOW()`, or `UUID()`. Sequences come from a 0-9 digit cross-join. Re-seeding drops and recreates the tables.

| Table | Rows |
| --- | ---: |
| `users` | 1,000 |
| `tags` | 50 |
| `articles` | 10,000 |
| `article_tags` | 30,000 |
| `comments` | 50,000 |
| `follows` | 10,000 |

Every user stores the same bcrypt cost-10 hash of `cwm-bench-password`.

## Local check

```bash
cd app-typical && npm ci --omit=dev --ignore-scripts && npm run check
```

A MySQL 8.0 correctness check (row counts, a second seed, response shapes) is `node tests/typical/correctness.mjs` when Docker is available.
