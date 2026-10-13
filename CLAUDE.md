Bun CLI plus a Claude Code skill. All data comes from Firecrawl Alexandria (`POST /v2/scrape` with an `alexandria` array of up to 10 calls), cached for 12 hours in `~/.cache/model-picker`.

- `src/alexandria.ts`: the one HTTP client: batching, cache, 429 retry.
- `src/models.ts`: Artificial Analysis leaderboard and the cost/score frontier.
- `src/providers.ts`: per-provider endpoints for one model.
- `skills/model-picker/SKILL.md`: how Claude Code should use the CLI.

Alexandria allows about 15 requests a minute on small plans: batch calls into one request instead of looping.

## Testing
Few tests, mostly end-to-end. `tests/cli.test.ts` runs the real CLI against a local stub of the Firecrawl API (`FIRECRAWL_API_URL`), so tests cost no credits.
