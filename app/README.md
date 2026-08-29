# Reference application

Tiny Node **20** CRUD service that defines the CWM canonical workload. It is not a TPC clone and it is not a product catalog.

Pinned runtime: Node.js `>=20 <21` (see `package.json` `engines`). Dependencies are pinned in `package.json`.

## Endpoints

| Method | Path | Touches DB | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | no | Process liveness for the ALB. Intentionally **not** a DB ping. |
| `GET` | `/api/meta` | no | Runtime, `APP_POOL_SIZE`, git SHA. |
| `GET` | `/api/products/:id` | read | Single-row product fetch. |
| `GET` | `/api/products` | read | List first 50 products by id. |
| `POST` | `/api/orders` | write | Insert one order row. Body: `{"productId":1,"qty":1}`. |
| `GET` | `/api/cpu-spin?ms=N` | no | Userspace CPU burn only. Used by the cpu-only diagnostic. |

ALB health checks use `/health` without the database so connection saturation stays visible instead of being hidden by target deregistration.

## Error classes

Every error response is JSON:

```json
{"error":{"class":"too_many_connections","message":"..."}}
```

| `class` | Meaning |
| --- | --- |
| `db_timeout` | Client-side or protocol timeout talking to MySQL. |
| `too_many_connections` | Server rejected the session (`ER_CON_COUNT_ERROR` / 1040). |
| `queue_full` | mysql2 pool queue limit reached (`APP_QUEUE_LIMIT`). |
| `cpu_overload` | Too many concurrent `/api/cpu-spin` burns. |
| `internal` | Everything else, including 4xx validation. |

`iops_throttle` is **not** emitted here. gp2 `BurstBalance` hitting 0 is a third, CloudWatch-derived bucket. Do not fold it into CPU or DB connection failures. See `schema/` and `holdout/REPORT.md`.

## Connection pool

`APP_POOL_SIZE` sets mysql2 `connectionLimit`. Terraform default is **250** so two app nodes can present **500** sessions toward the RDS `max_connections` override (also default 500). That pairing is a declared topology choice so the pool-bound diagnostic can saturate the cited cap. It is not a CloudWatch observation.

`APP_QUEUE_LIMIT` (default 50) is the mysql2 `queueLimit`. Exhaustion is `queue_full`.

## Request mix (k6)

Declared mix for `load/scenarios.js`:

- 70% `GET /api/products/:id`
- 20% `GET /api/products`
- 10% `POST /api/orders`

The cpu-only diagnostic does **not** use this mix; it only hits `/api/cpu-spin`.

## Dataset

`seed/seed.sql` is the fixed dataset. Row counts:

| Table | Rows |
| --- | ---: |
| `categories` | 8 |
| `products` | 200 (ids 1–200) |
| `orders` | 0 at seed; writes append |

Do not enlarge the seed to change latency or error rates. A different dataset is a different campaign.

## Local run

Requires a MySQL 8.0 instance and the seed applied.

```bash
export MYSQL_HOST=127.0.0.1
export MYSQL_USER=cwmbench
export MYSQL_PASSWORD=...
export MYSQL_DATABASE=cwmbench
export APP_POOL_SIZE=250
npm --prefix app ci
npm --prefix app start
```

Node 20 is required. Node 22 in a developer shell is fine for editing; the measured runtime on the instances is Node 20.
