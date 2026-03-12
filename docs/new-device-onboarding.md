# New Device Onboarding

This is the new preferred flow for adding a brand new ESP32 without a second manual key-edit flash.

## What changed

The firmware can now:

1. boot with the shared bootstrap `DEVICE_API_KEY`
2. derive its hardware `deviceId`
3. call `device-bootstrap`
4. download its own unique per-device API key
5. store that key in NVS
6. switch future manifest calls to the stored key automatically

That means the add-device flow is now:

1. USB flash once
2. read the new `Device ID`
3. provision in the portal
4. let the board self-finish

## One-time backend step

Run:

- `supabase/bootstrap-upgrade.sql`

Then deploy:

```powershell
cmd /c npx supabase functions deploy provision-device --no-verify-jwt
cmd /c npx supabase functions deploy device-bootstrap --no-verify-jwt
```

## Firmware config for bootstrap builds

In `test/include/secrets.h` set:

```cpp
#define DEVICE_ID_OVERRIDE ""
#define DEVICE_BOOTSTRAP_URL "https://YOUR_PROJECT_REF.supabase.co/functions/v1/device-bootstrap"
#define DEVICE_MANIFEST_URL "https://YOUR_PROJECT_REF.supabase.co/functions/v1/device-manifest"
#define DEVICE_API_KEY "YOUR_SHARED_BOOTSTRAP_DEVICE_KEY"
```

Important:

- `DEVICE_API_KEY` here is the shared bootstrap key from `PRAYERBOX_DEVICE_API_KEY`
- after provisioning, the board stores its unique per-device key in NVS and stops using the shared key for manifest auth

## Add a brand new board

1. Plug in the new ESP32 over USB
2. Erase flash if you want a clean start
3. Build and upload the current firmware
4. Open Serial Monitor
5. Wait for:

```text
Device ID: esp32-xxxxxxxxxxxx
Checking device bootstrap...
Bootstrap status: 404
```

`404` here is fine before the board is provisioned.

6. In the portal, sign in as admin
7. Go to `Provision Device`
8. Enter the new `Device UID`
9. Choose the group, usually `main`
10. Click `Provision Device`

Expected board behavior within the retry window:

```text
Checking device bootstrap...
Bootstrap status: 200
Stored per-device API key in NVS.
Checking device manifest...
Manifest status: 200
```

At that point the board is onboarded without another USB reflash.

## If the board does not self-finish

Check these in order:

1. `DEVICE_BOOTSTRAP_URL` is set correctly
2. the board was flashed with the shared bootstrap `DEVICE_API_KEY`
3. `bootstrap-upgrade.sql` was applied
4. `device-bootstrap` was deployed
5. the portal provisioning succeeded for that exact `Device ID`

## Claiming still happens separately

Provisioning prepares the board.

Claiming assigns the board to a user.

So the normal human flow is:

1. admin provisions the device
2. board self-fetches its unique key
3. user signs in and claims it with the portal claim code
