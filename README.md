# Dealvy — code showcase

Dealvy is a price comparison and social shopping platform for the Italian market: it
compares prices across thousands of shops in real time (new, used, refurbished) and
adds a social layer on top — you follow people and see the products they recommend and
why. It's live at [dealvy.online](https://dealvy.online), with an Android app on Google
Play. I built and run it on my own.

This README is about **how it's built**, not what it does as a product. It documents
the architecture, the folder structure, where each part runs, the data model, and the
main technical decisions.

> **About this repo.** This is not the full source. It's a hand-picked set of files —
> one per layer — cleaned up, translated to English, and stripped of anything private
> (keys, secrets, internal data). The files are here to be read, not deployed.

---

## Architecture — where things run

It's a single Next.js app (App Router) on Vercel, behind Cloudflare, talking to Supabase
and Redis, wrapped as a native app with Capacitor. The parts run in different places:

```
                         Cloudflare  (CDN + WAF / bot protection)
                                        |
                                        v
        +------------------  Next.js app on Vercel  ------------------+
        |                                                             |
   proxy.js  (edge)                                    route handlers  (server)
   bot filter + locale detection            +----------+----------+--------+-------+
        |                                  search      cron       push     email
        v                                  /api/cerca  check-alerts /api/push /api/email
   App Router pages                        /api/cerca- send-digest
   (client-rendered, PWA)                   esplora    feed-refresh
        |                                       |          |          |       |
        +------------------+--------------------+----+-----+----------+-------+
                           v                         v
                     Upstash Redis            Supabase (Postgres + RLS + Auth)
                     cache + rate limit       data + user accounts

   External scheduler (cron-job.org)  -->  calls the cron endpoints on a fixed schedule
   Search providers (Serper / SerpAPI / SearchAPI / Zenserp / eBay)  <--  called by search
   Capacitor wraps the same web app into the Android (live) and iOS builds
```

- **Client** — App Router pages, rendered in the browser. Installable as a PWA.
- **Edge** (`proxy.js`) — runs before routing on every request: filters non-browser
  clients on the search path, and resolves the UI language.
- **Server** (route handlers under `app/api`) — search, cron jobs, web push, email,
  affiliate, admin. These hold the secrets and the service-role database access.
- **Scheduled** — cron jobs aren't run by Vercel; an external scheduler (cron-job.org)
  hits the cron endpoints on a schedule, guarded by a shared secret.
- **Data** — Supabase Postgres (with row-level security) for data and auth; Upstash
  Redis for the search cache and rate-limit counters.
- **Native** — Capacitor wraps the live site into an Android app (on the Play Store)
  and an iOS build. The wrapper points at the web app, so shipping the web ships the app.

---

## Project structure

Simplified logical tree — build artifacts (`android/**/build`, `.next`), `node_modules`
and config files are omitted.

```
dealvy/
  app/                            # Next.js App Router
    api/                          # server route handlers
      cerca/                      # product search: provider cascade, cache, rate limit
      cerca-esplora/              # search variant: relevance-ordered ("explore" mode)
      check-alerts/               # cron: compare tracked prices against user targets
      send-digest/                # cron: email a digest of triggered price alerts
      feed-statico-refresh/       # refresh the static product pool that backs the feeds
      push/                       # web push: subscribe, send, vapid-key
      email/                      # transactional email
      awin-click/  awin-sync/     # affiliate (Awin): click logging + feed sync
      ebay/                       # eBay integration (+ required account-deletion callback)
      admin/                      # internal analytics API: stats, login
      health/                     # uptime healthcheck endpoint
      cancella-account/           # account deletion
    login/  profilo/  lista/  notifiche/  social/   # main user pages
    u/[username]/                 # public user profiles
    storico-prezzi/               # price-history chart (noindex)
    prezzi/[slug]/                # SEO landing pages (auto-search on load)
    invito/[token]/               # shared-list invite pages
    privacy/  termini/  admin/    # legal + internal dashboard
  lib/
    supabase.js                   # Supabase client
  messages/                       # i18n dictionaries: it, en, es, fr, de, pt
  public/
    sw.js  manifest.json  icons   # service worker + PWA assets
  proxy.js                        # edge middleware: bot filter + locale detection
  android/                        # Capacitor Android wrapper (published to Play Store)
  ios/                            # Capacitor iOS wrapper
```

Route naming note: the app is Italian-first, so folders are Italian (`cerca` = search,
`lista` = wishlist, `prezzi` = prices). In the files included here I've anglicised names
for readability; the mapping is noted per file.

---

## Data model (Supabase / Postgres)

The main tables, by role. Names are anglicised here; the real schema uses Italian names
(e.g. `storico_prezzi`, `consigli`).

| Table (real name) | Role |
|---|---|
| `storico_prezzi` — price history | Every search writes a few result rows here. Backs the price-history chart, the "daily deals" logic, and the personalised feed. |
| `feed_statico` — static feed | A curated/auto product pool that keeps the home feeds populated when there's little search data. A `tipo` column marks rows `auto` vs `curato` (hand-curated rows are never auto-deleted). |
| `consigli` — recommendations | The social layer's atomic unit: a product plus a **required** free-text message (the "why"). Public read, owner-only write. |
| `follows` | Follow graph: `follower_id` -> `seguito_id`. |
| `profili` — profiles | `username`, `avatar_url`, `bio`, `privacy`. Joined to recommendations client-side (no FK). |
| `lista_desideri` — wishlist | Saved products per user. |
| `alert_prezzi` — price alerts | Target price per product; a cron marks them triggered, a second cron emails the digest and deactivates them. |
| `liste_condivise` (+ `_membri`, `_prodotti`) — shared lists | Collaborative lists with a share `token`, members, and products. |
| `prodotti_condivisi` — shared products | Product sent from one user to another. |
| `notifiche_social` — social notifications | Per-user social events, with a `jsonb` payload. |
| `push_subscriptions` | Web Push subscriptions (`jsonb`) per user. |
| `feed_awin`, `awin_clicks` | Affiliate (Awin) product feed and click logging. |

**Row-level security is central.** RLS is on for every table. The anonymous-readable
feeds (price history, recommendations, profiles, static feed) need explicit public
`SELECT` policies, or logged-out visitors see empty feeds — this was a recurring source
of bugs. Writes are restricted to the owning user. The cron jobs use the Supabase
service-role key to bypass RLS and read across all users.

---

## Request flows

**Search** (`/api/cerca`):

```
request
  -> proxy.js       reject obvious non-browser clients on the search path
  -> rate limit     per-IP counters in Redis (per minute + per day)
  -> cache          return the cached result if this query ran recently (24h TTL)
  -> providers      try in order until one returns results:
                      Serper -> SearchAPI -> Zenserp   (SerpAPI first for "used")
                      + an eBay lookup merged on top
  -> classify       tag each result New / Used from its title and source
  -> cache + store  cache the result; write a few rows to price history (async)
  -> response
```

**Social feed** — a three-rung "never empty" cascade so the feed always has content:

```
people you follow        (logged in)
  |- if too few -> recommendations from the most-followed accounts
       |- if still too few -> the most recent recommendations overall
```

That last rung matters for cold-start: a recommendation from someone with no followers
yet would otherwise never be shown to anyone, even though the data exists.

---

## The files in this repo

Each file has a header comment with more detail; here's the responsibility and the main
technical decision in each.

- **`app/api/search/route.js`** (`/api/cerca`) — the search endpoint. Orchestrates the
  provider cascade, the Redis cache, per-IP rate limiting, and new/used classification.
  *Decision:* the providers are paid, so a 24h cache on repeated queries and a strict
  fallback order (don't call provider 2 unless provider 1 returned nothing) keep both
  cost and failure risk down.

- **`app/home/useHomeFeeds.js`** — the data logic for the three home feeds, extracted
  into a hook. *Decisions:* "for you" and "daily deals" draw from the same pool, so a
  de-dup runs at render time; deals require a real price drop vs. the historical max (no
  invented discounts); profiles are merged into recommendations client-side because
  there's no FK between the two tables.

- **`app/home/RecommendedFeed.jsx`** — the social feed UI: a card that is literally
  "product + who recommended it + why". Presentational only — data and handlers come in
  as props.

- **`app/api/send-digest/route.js`** — a cron endpoint. Shared-secret auth, groups
  triggered alerts per user, sends one email each via Resend, and only marks an alert
  notified after a successful send (so a failed send retries next run).

- **`proxy.js`** — edge middleware doing two jobs: a cheap first-line bot filter on the
  search path, and locale detection (explicit cookie -> `Accept-Language` -> Italian).
  *Note:* this is deliberately only the outer layer; the real bot defence is the
  Cloudflare WAF plus the in-route rate limiting.

- **`public/sw.js`** — the service worker. Handles Web Push (price-alert notifications)
  and routes the click back into the app. *Decision:* it has no fetch handler — an
  earlier no-op one added measurable overhead on every navigation, so it was removed.

- **`app/globals.css`** — the design system: a token layer (palette, ink scale, radii,
  shadows) and a sample of components built on it. Small fixed palette, hairline borders,
  one card radius, soft shadows.

---

## Some technical choices worth calling out

- **Provider cascade over a single search API** — resilience to any one provider being
  down or rate-limited, without paying for all of them on every query.
- **Redis for cache *and* rate limiting** — one dependency covers repeated-query caching
  (cost) and per-IP throttling (abuse).
- **Layered bot defence** — Cloudflare WAF (managed challenge on suspicious traffic) +
  edge User-Agent filter + in-route rate limiting, rather than trusting any single layer.
  Learned the hard way: a User-Agent blocklist alone misses bots that fake a real browser.
- **Never fabricate data** — no invented discount percentages or fake social signals.
  A product with no real price history gets a neutral tag, not a made-up "-X%".
- **PWA + Capacitor** — one web codebase serves the website, the installable PWA, and the
  native wrappers, instead of maintaining separate native apps.

---

## Notes on the sanitized code

Changes made so this could be public, without misrepresenting anything:

- Credentials are read from environment variables — none are in the code.
- Rate-limit thresholds are illustrative; the real values aren't published.
- The bot-detection list in `proxy.js` is trimmed to a sample.
- Table/column names were anglicised (e.g. `storico_prezzi` -> `price_history`).
- The keyword and domain lists that detect used vs. new items are kept in Italian on
  purpose — they match Italian queries and listings.

---

This is a showcase of my own work. Please don't reuse the code as a base for another
project.
