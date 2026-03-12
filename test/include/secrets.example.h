#pragma once

// Copy this file to secrets.h and fill in your real values.

#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Leave empty to derive a stable device ID from the ESP32 hardware.
#define DEVICE_ID_OVERRIDE ""
#define DEVICE_GROUP_ID "main"

#define MQTT_HOST "YOUR_MQTT_HOST"
#define MQTT_PORT 8883
#define MQTT_USERNAME "YOUR_DEVICE_MQTT_USERNAME"
#define MQTT_PASSWORD "YOUR_DEVICE_MQTT_PASSWORD"

// Paste your broker root CA certificate here if available.
// Leave empty only for local development.
#define MQTT_ROOT_CA ""

#define DEVICE_MANIFEST_URL "https://YOUR_PROJECT_REF.supabase.co/functions/v1/device-manifest"
#define DEVICE_API_KEY "YOUR_DEVICE_API_KEY"
#define DEVICE_MANIFEST_ROOT_CA ""
#define OTA_ROOT_CA ""
// Leave at 0 until the manifest includes a real 64-character SHA-256 checksum.
#define AUTO_APPLY_OTA 0

// Use a simple onboard LED for the MVP.
#define LED_PIN 13
#define BUTTON_PIN 18

// Set to 1 if HIGH turns the light on, 0 if LOW turns the light on.
#define LED_ACTIVE_HIGH 1

// Set to LOW or HIGH depending on your button wiring.
#define BUTTON_ACTIVE_STATE LOW
