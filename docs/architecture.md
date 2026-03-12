# Architecture

## Goal

Build a network of ESP32 devices in different homes that all react to the shared state of a group.

Rules:
- 0 active devices: all lights off
- 1 active device: all lights solid on
- 2+ active devices: all lights flash

Each device is assigned to a single user and belongs to a group.

## Recommended MVP

Use a cloud-centric design:

1. Each ESP32 connects to local Wi-Fi.
2. Each ESP32 publishes activation changes to MQTT.
3. A backend service updates the database and computes the current group lighting mode.
4. The backend publishes the current lighting mode to the group command topic.
5. All ESP32 devices in that group subscribe to the same command topic and update their light output.

This avoids unreliable peer-to-peer behavior across houses and NAT boundaries.

## Services

### MQTT broker

Use a managed MQTT broker for real-time device fanout.

Responsibilities:
- accept device connections over TLS
- deliver activation events
- deliver group lighting commands
- expose online/offline state using heartbeats or will messages

### Backend API / function

Use a small backend service, serverless function, or Supabase Edge Function.

Responsibilities:
- verify device ownership and group membership
- write activation changes into Postgres
- count active devices per group
- publish the current group mode to MQTT
- power admin and provisioning workflows

### Database

Use Postgres to store:
- users
- user profiles
- groups
- devices
- claim codes and ownership history
- current device activation states
- event history

## MQTT contract

### Device topics

```text
devices/{deviceId}/activation
devices/{deviceId}/heartbeat
devices/{deviceId}/status
```

### Group topics

```text
groups/{groupId}/lighting_mode
groups/{groupId}/state
```

### Example activation payload

```json
{
  "deviceId": "esp32-001",
  "groupId": "main",
  "active": true,
  "uptimeMs": 120500
}
```

### Example lighting mode payload

Plain string payloads are fine for the MVP:

```text
off
solid
flash
```

You can switch to JSON later if you need more metadata.

## Provisioning flow

Recommended flow:

1. Each ESP32 is flashed with a unique `deviceId`.
2. Each device has a claim code or QR code.
3. A logged-in user claims the device in the app.
4. The backend binds the device to that user and a group.
5. The device receives or is flashed with per-device MQTT credentials.

Do not reuse the same MQTT credentials on every device.

## Firmware responsibilities

Each ESP32 firmware instance should:
- connect to Wi-Fi
- connect to MQTT over TLS
- publish local activation changes
- subscribe to the group lighting topic
- drive an LED, relay, or other output
- store device identity and configuration in nonvolatile storage
- reconnect cleanly after power loss or Wi-Fi outages

## Security

Minimum security requirements:
- TLS MQTT
- per-device credentials
- device ownership checks in the backend
- RLS on app-facing database tables
- OTA update plan

If you control real house wiring, use proper isolated relay hardware or certified smart lighting hardware. Do not drive mains loads directly from an ESP32 pin.

## Suggested next steps

1. Finish the firmware scaffold in `test/` with your real Wi-Fi and broker credentials.
2. Create the Postgres schema from `supabase/schema.sql`.
3. Add a backend function that recalculates `lighting_mode` after each activation event.
4. Run `supabase/ownership-upgrade.sql` in existing projects to add claim codes and ownership history.
5. Build a small app to claim devices and assign them to users.
