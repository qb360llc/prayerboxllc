# Production Hardening

This is the order to harden the current MVP without breaking the flow you already tested.

## 1. Apply database security

Run:

- `supabase/security-hardening.sql`

This adds:

- `profiles.is_admin`
- `device_api_keys`
- profile auto-create trigger
- row level security policies for user-facing tables

Then mark your admin user:

```sql
update profiles
set is_admin = true
where email = 'prayerboxllc@gmail.com';
```

## 2. Redeploy portal-facing functions

After applying the SQL, redeploy:

```powershell
cmd /c npx supabase functions deploy claim-device --no-verify-jwt
cmd /c npx supabase functions deploy my-devices --no-verify-jwt
cmd /c npx supabase functions deploy firmware-releases --no-verify-jwt
cmd /c npx supabase functions deploy provision-device --no-verify-jwt
cmd /c npx supabase functions deploy device-manifest --no-verify-jwt
```

Why:

- `firmware-releases` now requires `profiles.is_admin = true` for writes
- `device-manifest` now supports per-device API keys
- portal-facing functions now support a single configured browser origin

## 3. Move off the shared device API key

Current state:

- `PRAYERBOX_DEVICE_API_KEY` is still supported as a fallback

Target state:

1. use the portal `Provision Device` screen
2. mint a unique per-device API key for each board
3. update that board’s `DEVICE_API_KEY` to the returned value
4. flash once over USB or deliver it during your next controlled OTA cycle
5. repeat until all boards are migrated
6. remove the global fallback secret or rotate it to a dead value

## 4. Stop insecure TLS on manifest and OTA

Current firmware still falls back to insecure TLS when no CA is configured.

Set these in `test/include/secrets.h` for production:

```cpp
#define DEVICE_MANIFEST_ROOT_CA "..."
#define OTA_ROOT_CA "..."
```

Then rebuild and reflash once before relying on OTA widely.

## 5. MQTT credential hardening

Current firmware still uses static MQTT username/password values in `secrets.h`.

Short-term production minimum:

1. issue a different MQTT username/password per board
2. bind each username to the board identity in EMQX auth rules
3. rotate test credentials out of service

Longer-term:

1. automate EMQX credential issuance during provisioning
2. stop storing shared credentials in the repo-local workflow entirely

## 6. Checksum enforcement

The OTA path now verifies `checksum_sha256` before finalizing an update.

Production rule:

1. every new active firmware release must include a valid 64-character lowercase SHA-256
2. the device will skip automatic OTA if the checksum is missing or malformed
3. the device will reject the update if the downloaded binary hash does not match

Generate the checksum on Windows with:

```powershell
Get-FileHash .\test\.pio\build\esp32dev\firmware.bin -Algorithm SHA256
```

Then paste the lowercase `Hash` value into the portal `SHA-256 Checksum` field.

Still recommended next:

1. report OTA success/failure back into `device_firmware_status`
2. surface that status in the portal
