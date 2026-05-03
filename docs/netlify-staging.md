# Netlify Staging Setup

This repo is now prepared to generate [portal/config.js](/C:/Users/bquoc/Documents/PRayerbox/portal/config.js) from Netlify environment variables during builds.

## Goal

Use:

- production Netlify site -> production Supabase
- staging Netlify site -> staging Supabase

This avoids testing new UI/features against live data.

## What the build does

During Netlify builds, [scripts/prepare-portal-config.mjs](/C:/Users/bquoc/Documents/PRayerbox/scripts/prepare-portal-config.mjs) will:

- read `PRAYERBOX_PROJECT_URL`
- read `PRAYERBOX_ANON_KEY`
- read `PRAYERBOX_VAPID_PUBLIC_KEY`
- write [portal/config.js](/C:/Users/bquoc/Documents/PRayerbox/portal/config.js)

If those variables are missing, it keeps the existing checked-in `config.js` as a fallback.

## Recommended architecture

Set up 2 Netlify sites connected to this same GitHub repo:

1. Production site
2. Staging site

Recommended branches:

1. `main` -> production
2. `staging` -> staging

You can also use Deploy Previews for PRs, but a dedicated staging site is cleaner for repeated testing.

## Netlify site setup

### Production site

In Netlify:

1. Site settings
2. Build & deploy
3. Continuous deployment
4. Production branch = `main`

Environment variables:

- `PRAYERBOX_PROJECT_URL` = production Supabase URL
- `PRAYERBOX_ANON_KEY` = production anon key
- `PRAYERBOX_VAPID_PUBLIC_KEY` = production web push public key

### Staging site

Create a second Netlify site connected to the same repo.

In Netlify:

1. Site settings
2. Build & deploy
3. Continuous deployment
4. Production branch = `staging`

Environment variables:

- `PRAYERBOX_PROJECT_URL` = staging Supabase URL
- `PRAYERBOX_ANON_KEY` = staging anon key
- `PRAYERBOX_VAPID_PUBLIC_KEY` = staging web push public key

## Strong recommendation

Use a separate staging Supabase project.

If staging Netlify points to production Supabase, then staging still changes live data, sends live notifications, and writes live prayer/chat/feed activity.

## Suggested next steps

1. Create `staging` branch from `main`
2. Create a staging Supabase project
3. Copy schema/functions needed for staging
4. Create second Netlify site targeting `staging`
5. Add the staging `PRAYERBOX_*` variables in Netlify
6. Test one deploy on staging before relying on it

## Nice-to-have later

Once both sites are confirmed using Netlify env vars correctly, we can remove the checked-in production values from [portal/config.js](/C:/Users/bquoc/Documents/PRayerbox/portal/config.js) and switch to env-only config generation.
