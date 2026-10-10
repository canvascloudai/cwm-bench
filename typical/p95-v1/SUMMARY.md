# P95 model holdout: one-page summary (draft rev 2, for Kevin)

**What this is.** A plan to test the new P95 formula on runs it has never seen, before anyone builds it into the engine. Nothing has run, been filed or been published. Rev 2 applies the external review.

**What we'd run.** 1, 2 and 3 app servers on the same typical setup. Each run starts at 300 RPS and steps down to 200, then 100, on a fresh database. That's the reverse of every run the formula was fitted on. There are 3 separate stacks per server count, so 9 applies over 3 days, with each server count run once per day in a rotating order.

**Time and cost.** About 11.4 hours of AWS time (about 3.8 h a day), roughly $12–14 including MySQL Extended Support. Up to 6 replacement runs are allowed, with a $40 budget. If that would be exceeded, the runner pauses with nothing running and asks Kevin whether to continue; the result is labeled partial only if he decides to stop.

**What we predict now (frozen before running).**

| Setup | New formula | Acceptance tolerance | Old engine (1.2.14) |
|---|---:|---|---:|
| 1 server, 300 RPS | 106 ms | 71–152 | 18 |
| 1 server, 200 RPS | 32 ms | 21–46 | 15 |
| 1 server, 100 RPS | 10 ms | 6–14 | 11 |
| 2 servers, 300 RPS | 34 ms | 23–49 | 13 |
| 2 servers, 200 RPS | 15 ms | 10–21 | 11 |
| 2 servers, 100 RPS | 8 ms | 5–11 | 9 |
| 3 servers, 300 RPS | 23 ms | 16–34 | 11 |
| 3 servers, 200 RPS | 12 ms | 8–17 | 10 |
| 3 servers, 100 RPS | 8 ms | 5–11 | 9 |

One server at 300 RPS is at the edge of what the formula covers (300 RPS on one server). Only one earlier setup sits there, so this is the hardest test. Passing it says nothing about loads above that.

The ranges are acceptance tolerances we chose, not proven 90% ranges. They are deliberately a bit wide because some noise is counted twice.

**How we judge it: two separate results.** We use the middle value of 3 runs per setup.
1. **Absolute P95.** All three must hold: at least 8 of 9 setups in range, including all three 300 RPS setups; a typical accuracy score of at least 80; and better than the engine at all three 300 RPS setups.
2. **Server changes (2→1 and 2→3).** It has to get the direction right and the size within a set range: ×/÷1.6 at 200/300 RPS and ×/÷1.3 at 100 RPS, worked out from how noisy a ratio of two medians is. Both changes must pass at 300 RPS, and at least 3 of the other 4.

**What each outcome means.**
- **Both pass:** we can say the scaling problem is fixed (under these conditions), and you decide whether to file the engine ticket.
- **Only absolute passes:** we say "absolute P95 validated under tested conditions" and do **not** claim scaling is fixed. No engine ticket unless you decide otherwise.
- **Absolute fails:** the formula isn't built, and the accuracy page keeps its caveat.
- If it loses to the engine in a 300 RPS setup, that only means it didn't beat the engine there. It doesn't tell us latency came in low.

**Honest odds (simulated with assumed noise, not known probabilities).** Even if the formula is right, it passes absolute about 80% of the time, server changes about 74%, and both about 66%.

**Your calls:** approve the 1×/2×/3× plan and budget; more reps if those odds seem too low; pool-wait instrumentation [optional].
