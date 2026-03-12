# Claim Portal

This is a minimal browser portal for the device claim flow.

File:

- `portal/index.html`

## What it does

1. accepts your Supabase project URL and anon key
2. signs a user in or up with Supabase Auth
3. calls `claim-device`
4. calls `my-devices`
5. lets admins create firmware releases
6. lets admins provision a device-specific API key and claim code
7. shows the claimed device details, group, online state, and current firmware version

## Before using it

1. deploy `claim-device` with:

```powershell
cmd /c npx supabase functions deploy claim-device --no-verify-jwt
```

2. deploy `my-devices` with:

```powershell
cmd /c npx supabase functions deploy my-devices --no-verify-jwt
```

3. deploy `firmware-releases` with:

```powershell
cmd /c npx supabase functions deploy firmware-releases --no-verify-jwt
```

4. deploy `provision-device` with:

```powershell
cmd /c npx supabase functions deploy provision-device --no-verify-jwt
```

5. set the allowed hosted portal origin:

```powershell
cmd /c npx supabase secrets set PRAYERBOX_PORTAL_ORIGIN=https://portal.yourdomain.com
```

For local testing, you can leave `PRAYERBOX_PORTAL_ORIGIN` unset.

6. seed claim codes in Supabase SQL Editor:

```sql
insert into device_claim_codes (device_id, claim_code, expires_at)
select id, 'CLAIM-ESP32-A', now() + interval '7 days'
from devices
where device_uid = 'esp32-449cf4ce877c'
on conflict (device_id) do nothing;

insert into device_claim_codes (device_id, claim_code, expires_at)
select id, 'CLAIM-ESP32-B', now() + interval '7 days'
from devices
where device_uid = 'esp32-dc5e6ce6e2e0'
on conflict (device_id) do nothing;
```

## How to use it

1. open `portal/index.html` in a browser, or host the `portal/` folder and edit `portal/config.js`
2. set:
   - Supabase project URL
   - Supabase publishable key
3. sign in with a test user
4. enter `CLAIM-ESP32-A` or `CLAIM-ESP32-B`
5. click `Claim Device`
6. if you are an admin, create a new firmware release or provision a device-specific API key from the portal

Expected result:
- the page shows the claimed device UID and group
- the page lists claimed devices for the signed-in user
- each device shows online state and current firmware version if reported
- the page lists firmware releases and lets you create a newer active release
- the page can mint a per-device claim code and API key for a board
- `devices.owner_user_id` is updated
- `device_ownership_history` gets a row

## Next step after this

Once this flow is stable, move it into a real web app and add:
- a custom domain
- stronger UI/branding
- QR code claim flow
- OTA release controls with checksum verification
