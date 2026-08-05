DOCKER-CONTAINERIZED GITHUB WORKFLOWS

All 10 workflows now run inside a Docker container instead of a bare Ubuntu
runner. Drop these into your repo's .github/workflows/ folder (replacing the
existing files of the same name).

CONTAINER PER WORKFLOW:
  Playwright (browser-based scrapers) -> mcr.microsoft.com/playwright:v1.62.1-noble
    scrape-cards, scrape-codex, community-decks, scrape-events, scrape-news,
    scrape-rewards, scrape-tcg-price, import-deck
  Node only (fetch-based, no browser) -> node:24-bookworm
    scrape-discord, scrape-youtube

WHAT CHANGED (and why):
  1. Added `container: image: ...` under each job. The Playwright image already
     ships Chromium + every OS dependency, so the slow, flaky
     `npx playwright install --with-deps` / `install-deps` steps are GONE
     (including the whole browser-binary cache dance in import-deck).
  2. Pinned `playwright@1.62.1` everywhere so the npm package matches the image
     tag (v1.62.1). THIS PAIR MUST STAY IN SYNC -- if you bump the image tag,
     bump the npm pin to match, or you'll get "browser executable doesn't exist".
  3. Added `git config --global --add safe.directory "$GITHUB_WORKSPACE"` to
     every commit step. Inside a container git runs as root against a checkout
     owned by a different UID; without this, git aborts with "detected dubious
     ownership" and the commit/push fails. (Your tcg-price workflow already had
     this; the others did not.)

EVERYTHING ELSE IS UNCHANGED: schedules/cron, workflow_dispatch, inputs, the
twice-per-tick runs (news/discord/youtube), all secrets (FIREBASE_SERVICE_ACCOUNT,
DISCORD_BOT_TOKEN), firebase-admin installs, the events multi-file commit, and
import-deck's separate `deck-results` branch flow.

NOTE: I standardized the tcg-price schedule comment to match its actual cron
(0 */12 = every 12 hours; the old comment said "every 2 hours" but the cron was
already 12h).
