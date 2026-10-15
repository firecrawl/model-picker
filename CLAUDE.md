Bun CLI plus a Claude Code skill. All data comes from Firecrawl Alexandria (`POST /v2/scrape` with an `alexandria` array of up to 10 calls), cached for 24 hours in `~/.cache/model-picker`.

- `src/alexandria.ts`: the one HTTP client: batching, cache, 429 retry.
- `src/models.ts`: Artificial Analysis leaderboard and the cost/score frontier.
- `src/providers.ts`: per-provider endpoints for one model.
- `src/work.ts`: difficulty floors, kinds of work and their benchmarks, shared by `build` and `chat`.
- `src/snap.ts`: SubQ Snap labels each step or message when `SUBQ_API_KEY` is set.
- `skills/model-picker/SKILL.md`: how Claude Code should use the CLI.
- `src/setup.ts`: `mp setup`, which asks for keys and saves them to `~/.config/model-picker/.env`. Hidden input uses blocking reads and `stty`, not `process.stdin`, because Bun stops seeing input from a `</dev/tty` redirect (how `install.sh` runs it).
- `src/paths.ts`: where Pi and the router live. A release (`scripts/package.sh`, `install.sh`) is a compiled binary with Pi's own release binary and `pi/router.ts` bundled to `router.js` beside it, so nothing under `pi/` may import Bun-only APIs or `src/paths.ts`.

Alexandria allows about 15 requests a minute on small plans: batch calls into one request instead of looping.

## Testing
Few tests, mostly end-to-end. `tests/cli.test.ts` runs the real CLI against a local stub of the Firecrawl API (`FIRECRAWL_API_URL`), so tests cost no credits.
