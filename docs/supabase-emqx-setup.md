# Supabase + EMQX Setup

This is the next stage after the ESP32 is already connecting to Wi-Fi and MQTT.

## 1. Create the Edge Function locally

The function scaffold is in:

- `supabase/functions/process-activation/index.ts`

It expects an HTTP `POST` containing:

```json
{
  "deviceId": "esp32-001",
  "groupId": "main",
  "active": true,
  "topic": "devices/esp32-001/activation",
  "uptimeMs": 120500
}
```

## 2. Install and log in to the Supabase CLI

Follow the official CLI install instructions, then run:

```powershell
supabase login
supabase link --project-ref <your-project-ref>
```

Official docs:
- https://supabase.com/docs/guides/cli
- https://supabase.com/docs/guides/functions

## 3. Set the Edge Function secrets

Add these function secrets before deployment:

```powershell
supabase secrets set PRAYERBOX_WEBHOOK_SECRET=<your-shared-secret>
supabase secrets set EMQX_API_BASE_URL=<your-emqx-api-base-url>
supabase secrets set EMQX_API_KEY=<your-emqx-api-key>
supabase secrets set EMQX_API_SECRET=<your-emqx-api-secret>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available inside Supabase Edge Functions automatically.

## 4. Deploy the function

Deploy it without JWT verification because EMQX will call it as a machine-to-machine webhook:

```powershell
supabase functions deploy process-activation --no-verify-jwt
```

The function URL will be:

```text
https://<project-ref>.supabase.co/functions/v1/process-activation
```

Official doc for deploy flags:
- https://supabase.com/docs/guides/functions/function-configuration#skipping-authorization-checks

## 5. Create EMQX deployment API credentials

In EMQX Cloud, create deployment API credentials that can publish messages back into your broker.

You need:
- API base URL
- API key
- API secret

Official docs:
- https://docs.emqx.com/en/cloud/latest/api/deployment_api/introduction.html
- https://docs.emqx.com/en/cloud/latest/api/deployment_api/create_app.html

## 6. Create an EMQX rule or webhook for activation topics

In EMQX Cloud, create a rule that matches:

```text
devices/+/activation
```

Have that rule call your Supabase Edge Function URL with:
- method: `POST`
- content type: `application/json`
- header: `x-prayerbox-webhook-secret: <same shared secret>`

Request body:

```json
{
  "deviceId": "${payload.deviceId}",
  "groupId": "main",
  "active": ${payload.active},
  "topic": "${topic}",
  "uptimeMs": ${payload.uptimeMs}
}
```

If your EMQX rule designer exposes different field names, keep the same output shape shown above.

Official docs:
- https://docs.emqx.com/en/cloud/latest/data_integration/webhook.html
- https://docs.emqx.com/en/cloud/latest/data_integration/introduction.html

## 7. Seed the first device row if you want predictable labels

For the current board:

```sql
insert into devices (device_uid, group_id, display_name)
select 'esp32-001', id, 'Living Room Test Device'
from app_groups
where slug = 'main'
on conflict (device_uid) do nothing;
```

This step is optional because the function can auto-create the device row on first activation.

## 8. Test the function directly before wiring EMQX

Use the Supabase Edge Function test panel or `curl`:

```powershell
curl -X POST "https://<project-ref>.supabase.co/functions/v1/process-activation" ^
  -H "Content-Type: application/json" ^
  -H "x-prayerbox-webhook-secret: <your-shared-secret>" ^
  -d "{\"deviceId\":\"esp32-001\",\"groupId\":\"main\",\"active\":true,\"topic\":\"devices/esp32-001/activation\",\"uptimeMs\":12345}"
```

Expected JSON:

```json
{
  "ok": true,
  "deviceId": "esp32-001",
  "groupId": "main",
  "activeCount": 1,
  "lightingMode": "solid"
}
```

## 9. End-to-end test

1. Press the ESP32 button or publish a test activation event.
2. EMQX forwards the activation to the Edge Function.
3. The Edge Function updates Supabase and publishes the group mode.
4. All devices in that group receive the new `groups/main/lighting_mode` message.

## 10. Add ownership and claim-code tables

If you already ran the original schema in Supabase, apply:

```sql
-- paste the contents of supabase/ownership-upgrade.sql
```

That adds:
- `profiles`
- `device_claim_codes`
- `device_ownership_history`
- `claim_device(claim_code, user_id)` helper function

## 11. Bring up a second ESP32

Use:
- `docs/two-device-test.md`

That guide walks through flashing `esp32-002`, testing `solid` with one active board, and testing `flash` with two active boards.
