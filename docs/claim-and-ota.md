# Claim And OTA

This is the most efficient path to stop manually editing firmware per device.

## 1. Device identity

The firmware now supports:

- `DEVICE_ID_OVERRIDE` for manual testing
- automatic hardware-derived IDs when `DEVICE_ID_OVERRIDE` is empty

If you leave:

```cpp
#define DEVICE_ID_OVERRIDE ""
```

the ESP32 will derive a stable ID from its eFuse MAC and log it on boot.

## 2. Claim portal flow

The backend pieces are:

- `supabase/ownership-upgrade.sql`
- `supabase/functions/claim-device/index.ts`

Portal flow:

1. user signs in with Supabase Auth
2. user enters a claim code from a sticker or QR code
3. frontend calls `claim-device`
4. `claim-device` runs the `claim_device(claim_code, user_id)` RPC
5. the device becomes owned by that user

Deploy the function with:

```powershell
cmd /c npx supabase functions deploy claim-device
```

For a first local test without building the portal yet, use:

```powershell
npm run claim:test -- ^
  --project-url https://YOUR_PROJECT_REF.supabase.co ^
  --anon-key YOUR_ANON_KEY ^
  --email devuser@example.com ^
  --password YourPassword123! ^
  --claim-code CLAIM-ESP32-001
```

The script will:
- sign in if the user already exists
- otherwise try to sign up
- call `claim-device` with the returned JWT

If sign-up succeeds but returns no access token, your Supabase project still requires email confirmation. For a dev-only flow, disable email confirmation temporarily or create/confirm the user first.

Then call it from your frontend with:

```http
POST /functions/v1/claim-device
Authorization: Bearer <user-jwt>
Content-Type: application/json

{ "claimCode": "CLAIM-ESP32-001" }
```

## 3. OTA manifest flow

The backend pieces are:

- `supabase/ota-upgrade.sql`
- `supabase/functions/device-manifest/index.ts`
- `supabase/functions/provision-device/index.ts`

The firmware now performs a read-only manifest check at boot and logs:
- the resolved device metadata
- the current group
- the latest firmware version
- whether an update is available

Automatic OTA install is now implemented behind:

```cpp
#define AUTO_APPLY_OTA 0
```

Leave it at `0` until:
- you flash the OTA partition table over USB once
- your firmware URL points to a real `.bin`
- you are ready for the device to install and reboot automatically

This function returns:

- device ownership/group information
- latest firmware metadata for a release channel

Deploy it with:

```powershell
cmd /c npx supabase secrets set PRAYERBOX_DEVICE_API_KEY=<shared-device-key>
cmd /c npx supabase functions deploy device-manifest --no-verify-jwt
```

For production, phase out the shared key:

1. deploy `provision-device`
2. issue a per-device API key for each board
3. replace `DEVICE_API_KEY` in each device config with that unique key
4. keep `PRAYERBOX_DEVICE_API_KEY` only as a short-lived fallback during migration

Example request:

```http
POST /functions/v1/device-manifest
Content-Type: application/json
x-prayerbox-device-key: <shared-device-key>

{
  "deviceId": "esp32-e8af1c02ab44",
  "channel": "stable",
  "currentVersion": "0.1.0"
}
```

Example response:

```json
{
  "ok": true,
  "device": {
    "deviceId": "esp32-e8af1c02ab44",
    "displayName": "Living Room Light",
    "groupId": "main",
    "groupName": "Main Network",
    "ownerUserId": "..."
  },
  "firmware": {
    "channel": "stable",
    "version": "0.2.0",
    "firmware_url": "https://...",
    "checksum_sha256": "..."
  }
}
```

## 4. OTA rollout model

Recommended rollout:

1. flash the current firmware once over USB with the OTA partition table in `test/partitions_ota.csv`
2. build firmware binary with PlatformIO
3. upload `.bin` to Supabase Storage or another HTTPS file host
4. generate the SHA-256 for that `.bin`
5. create a firmware release from the portal with both the URL and checksum
6. set `AUTO_APPLY_OTA 1` when you are ready to test installs
7. ESP32 checks `device-manifest`
8. ESP32 downloads and installs the binary over HTTPS when a newer version is available

Generate the checksum on Windows with:

```powershell
Get-FileHash .\test\.pio\build\esp32dev\firmware.bin -Algorithm SHA256
```

Paste the lowercase `Hash` value into the portal `SHA-256 Checksum` field.

## 5. What is still missing

The current OTA path still has one major dev-stage limitation left:

1. firmware downloads still use insecure TLS unless you set `DEVICE_MANIFEST_ROOT_CA` / `OTA_ROOT_CA`
