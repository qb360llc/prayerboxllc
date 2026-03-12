# PRayerbox MVP

This repository starts the MVP for a cross-house ESP32 light network.

Core behavior:
- one active device in a group -> all lights are solid on
- two or more active devices in a group -> all lights flash
- zero active devices in a group -> all lights are off

Recommended stack:
- ESP32 firmware in `test/`
- managed MQTT broker such as EMQX Cloud
- Supabase for auth, Postgres, and backend functions

Project layout:
- `docs/architecture.md`: system design, topic contract, and rollout notes
- `docs/claim-and-ota.md`: claim-code portal and OTA manifest workflow
- `docs/claim-portal.md`: browser-based claim portal setup
- `docs/portal-hosting.md`: how to host the portal as a real static site
- `docs/production-hardening.md`: RLS, admin role, per-device key, and TLS rollout
- `docs/supabase-emqx-setup.md`: backend integration steps between EMQX and Supabase
- `docs/two-device-test.md`: second board setup and multi-device test sequence
- `portal/`: minimal static portal for Supabase sign-in and device claiming
- `supabase/schema.sql`: initial database schema
- `supabase/ota-upgrade.sql`: additive SQL for OTA release metadata and device firmware status
- `supabase/ownership-upgrade.sql`: additive SQL for profiles, claim codes, and ownership history
- `supabase/functions/claim-device/`: Edge Function for portal-based device claiming
- `supabase/functions/firmware-releases/`: Edge Function for listing and creating firmware releases
- `supabase/functions/my-devices/`: Edge Function for listing claimed devices for the signed-in user
- `supabase/functions/provision-device/`: Edge Function for admin provisioning of claim codes and per-device API keys
- `supabase/functions/device-manifest/`: Edge Function for device config and OTA manifest checks
- `supabase/functions/process-activation/`: Edge Function scaffold for activation processing
- `test/`: PlatformIO firmware scaffold

Before building the firmware:
- edit `test/include/secrets.h` with your Wi-Fi and MQTT credentials
- point `DEVICE_ID` and `DEVICE_GROUP_ID` at a real device and group
