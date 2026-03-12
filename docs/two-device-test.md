# Two-Device Test

Use this after the first board is already online and reacting to `groups/main/lighting_mode`.

## 1. Prepare the second ESP32

Edit `test/include/secrets.h` for the second board:

```cpp
#define DEVICE_ID "esp32-002"
#define DEVICE_GROUP_ID "main"
#define LED_PIN 13
#define BUTTON_PIN 18
#define LED_ACTIVE_HIGH 0
#define BUTTON_ACTIVE_STATE LOW
```

Keep the same:
- Wi-Fi credentials
- MQTT host
- MQTT port
- MQTT username and password
- MQTT root CA

Then build and flash the second board.

## 2. Wire the second board

Recommended dev wiring:
- LED on the board's working status LED pin
- button from `GPIO18` to `GND`

The button is optional if you want to publish test events from MQTTX first.

## 3. Seed the second device row in Supabase

If you want the dashboard data to look clean before the first activation, run:

```sql
insert into devices (device_uid, group_id, display_name)
select 'esp32-002', id, 'Second Test Device'
from app_groups
where slug = 'main'
on conflict (device_uid) do nothing;
```

## 4. Optional claim-code setup

If you want to test user assignment later, seed claim codes:

```sql
insert into device_claim_codes (device_id, claim_code, expires_at)
select id, 'CLAIM-ESP32-001', now() + interval '7 days'
from devices
where device_uid = 'esp32-001'
on conflict (device_id) do nothing;

insert into device_claim_codes (device_id, claim_code, expires_at)
select id, 'CLAIM-ESP32-002', now() + interval '7 days'
from devices
where device_uid = 'esp32-002'
on conflict (device_id) do nothing;
```

## 5. Test sequence

### Test A: one active device

Publish from MQTTX:

Topic:

```text
devices/esp32-001/activation
```

Payload:

```json
{"deviceId":"esp32-001","groupId":"main","active":true,"uptimeMs":1000}
```

Expected result:
- both boards receive `solid`
- both LEDs stay on

### Test B: two active devices

Publish:

Topic:

```text
devices/esp32-002/activation
```

Payload:

```json
{"deviceId":"esp32-002","groupId":"main","active":true,"uptimeMs":1200}
```

Expected result:
- both boards receive `flash`
- both LEDs blink

### Test C: drop back to one active device

Publish:

Topic:

```text
devices/esp32-001/activation
```

Payload:

```json
{"deviceId":"esp32-001","groupId":"main","active":false,"uptimeMs":1800}
```

Expected result:
- `esp32-002` is still active
- group mode goes back to `solid`
- both boards return to steady on

### Test D: all inactive

Publish:

Topic:

```text
devices/esp32-002/activation
```

Payload:

```json
{"deviceId":"esp32-002","groupId":"main","active":false,"uptimeMs":2200}
```

Expected result:
- group mode becomes `off`
- both LEDs turn off

## 6. Test with physical buttons

After the MQTTX tests pass:

1. Press the button on `esp32-001`
2. Confirm the Serial Monitor shows `Published activation`
3. Press the button on `esp32-002`
4. Confirm both boards enter flash mode

Because the firmware now retries pending activation publishes after reconnect, a button press made during a short network outage should still be sent once MQTT reconnects.

