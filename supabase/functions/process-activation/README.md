# process-activation

This Supabase Edge Function handles device activation events from MQTT:

1. validate the incoming webhook secret
2. upsert the device row in Supabase
3. mark the device active or inactive
4. insert an event log row
5. compute the group's current `lighting_mode`
6. publish `off`, `solid`, or `flash` back to EMQX

Expected request body:

```json
{
  "deviceId": "esp32-001",
  "groupId": "main",
  "active": true,
  "topic": "devices/esp32-001/activation",
  "uptimeMs": 120500
}
```

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PRAYERBOX_WEBHOOK_SECRET`
- `EMQX_API_BASE_URL`
- `EMQX_API_KEY`
- `EMQX_API_SECRET`

The EMQX API publish endpoint should support:

```http
POST {EMQX_API_BASE_URL}/publish
Authorization: Basic <base64(apiKey:apiSecret)>
Content-Type: application/json

{
  "topic": "groups/main/lighting_mode",
  "payload": "solid",
  "qos": 0,
  "retain": false
}
```

