#include <Arduino.h>
#include <ESP.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#include "secrets.h"

#ifndef DEVICE_ID_OVERRIDE
#ifdef DEVICE_ID
#define DEVICE_ID_OVERRIDE DEVICE_ID
#else
#define DEVICE_ID_OVERRIDE ""
#endif
#endif

#ifndef DEVICE_MANIFEST_ROOT_CA
#define DEVICE_MANIFEST_ROOT_CA ""
#endif

#ifndef OTA_ROOT_CA
#define OTA_ROOT_CA DEVICE_MANIFEST_ROOT_CA
#endif

namespace {

enum class LightingMode {
  Off,
  Solid,
  Flash,
};

constexpr unsigned long kHeartbeatIntervalMs = 30000;
constexpr unsigned long kReconnectIntervalMs = 5000;
constexpr unsigned long kFlashIntervalMs = 400;
constexpr unsigned long kDebounceMs = 40;
constexpr unsigned long kManifestRetryIntervalMs = 60000;
#ifdef APP_VERSION
constexpr const char* kAppVersion = APP_VERSION;
#else
constexpr const char* kAppVersion = "0.0.0";
#endif

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);
WiFiClientSecure manifestClient;
WiFiClientSecure otaClient;

LightingMode currentMode = LightingMode::Off;
bool localActive = false;
bool lastButtonReading = false;
bool stableButtonReading = false;
bool flashOutputState = false;
bool activationNeedsPublish = true;
bool manifestChecked = false;
bool otaAttempted = false;

unsigned long lastHeartbeatMs = 0;
unsigned long lastReconnectAttemptMs = 0;
unsigned long lastFlashToggleMs = 0;
unsigned long lastDebounceMs = 0;
unsigned long lastManifestAttemptMs = 0;

char commandTopic[96];
char activationTopic[96];
char heartbeatTopic[96];
char statusTopic[96];
char runtimeDeviceId[32];

const char* deviceId() {
  return runtimeDeviceId;
}

String summarizeDeviceApiKey() {
  const size_t keyLength = strlen(DEVICE_API_KEY);
  if (keyLength == 0) {
    return "empty";
  }

  const size_t visibleChars = keyLength < 8 ? keyLength : 8;
  String summary = String(DEVICE_API_KEY).substring(0, visibleChars);
  summary += "... (len=";
  summary += keyLength;
  summary += ")";
  return summary;
}

bool ledOnSignal() {
#if LED_ACTIVE_HIGH
  return HIGH;
#else
  return LOW;
#endif
}

bool ledOffSignal() {
#if LED_ACTIVE_HIGH
  return LOW;
#else
  return HIGH;
#endif
}

const char* lightingModeToString(LightingMode mode) {
  switch (mode) {
    case LightingMode::Off:
      return "off";
    case LightingMode::Solid:
      return "solid";
    case LightingMode::Flash:
      return "flash";
  }

  return "off";
}

LightingMode parseLightingMode(const String& payload) {
  if (payload == "solid") {
    return LightingMode::Solid;
  }
  if (payload == "flash") {
    return LightingMode::Flash;
  }
  return LightingMode::Off;
}

void setOutput(bool on) {
  digitalWrite(LED_PIN, on ? ledOnSignal() : ledOffSignal());
}

void updateOutput() {
  const unsigned long now = millis();

  switch (currentMode) {
    case LightingMode::Off:
      setOutput(false);
      break;
    case LightingMode::Solid:
      setOutput(true);
      break;
    case LightingMode::Flash:
      if (now - lastFlashToggleMs >= kFlashIntervalMs) {
        lastFlashToggleMs = now;
        flashOutputState = !flashOutputState;
      }
      setOutput(flashOutputState);
      break;
  }
}

void publishJson(const char* topic, JsonDocument& doc, bool retained = false) {
  char buffer[256];
  const size_t len = serializeJson(doc, buffer, sizeof(buffer));
  if (len == 0 || len >= sizeof(buffer)) {
    return;
  }
  mqttClient.publish(topic, buffer, retained);
}

void logManifestResponse(const JsonDocument& doc) {
  JsonVariantConst device = doc["device"];
  if (!device.isNull()) {
    Serial.print("Manifest device: ");
    Serial.println(device["deviceId"] | "unknown");
    Serial.print("Manifest group: ");
    Serial.println(device["groupId"] | "unknown");
  }

  JsonVariantConst firmware = doc["firmware"];
  if (!firmware.isNull()) {
    const char* latestVersion = firmware["version"] | "unknown";
    Serial.print("Manifest firmware version: ");
    Serial.println(latestVersion);
    Serial.print("Current firmware version: ");
    Serial.println(kAppVersion);

    if (String(latestVersion) != kAppVersion) {
      Serial.println("Firmware update available.");
    } else {
      Serial.println("Firmware is up to date.");
    }
  } else {
    Serial.println("No active firmware release in manifest.");
  }
}

bool performOtaUpdate(const char* firmwareUrl) {
  if (!firmwareUrl || strlen(firmwareUrl) == 0) {
    Serial.println("Skipping OTA: manifest did not provide a firmware URL.");
    return false;
  }

  HTTPClient http;
  if (strlen(OTA_ROOT_CA) > 0) {
    otaClient.setCACert(OTA_ROOT_CA);
  } else {
    otaClient.setInsecure();
  }

  Serial.print("Starting OTA download from ");
  Serial.println(firmwareUrl);

  if (!http.begin(otaClient, firmwareUrl)) {
    Serial.println("Failed to start OTA HTTP request.");
    return false;
  }

  const int statusCode = http.GET();
  if (statusCode != HTTP_CODE_OK) {
    Serial.print("OTA HTTP GET failed with status ");
    Serial.println(statusCode);
    http.end();
    return false;
  }

  const int contentLength = http.getSize();
  if (contentLength <= 0) {
    Serial.println("OTA failed: invalid content length.");
    http.end();
    return false;
  }

  if (!Update.begin(contentLength)) {
    Serial.print("Update.begin failed: ");
    Serial.println(Update.errorString());
    http.end();
    return false;
  }

  WiFiClient& stream = http.getStream();
  const size_t written = Update.writeStream(stream);
  if (written != static_cast<size_t>(contentLength)) {
    Serial.print("OTA wrote ");
    Serial.print(written);
    Serial.print(" of ");
    Serial.print(contentLength);
    Serial.println(" bytes.");
  }

  if (!Update.end()) {
    Serial.print("Update.end failed: ");
    Serial.println(Update.errorString());
    http.end();
    return false;
  }

  http.end();

  if (!Update.isFinished()) {
    Serial.println("OTA failed: update not finished.");
    return false;
  }

  Serial.println("OTA update installed successfully. Rebooting...");
  delay(500);
  ESP.restart();
  return true;
}

void checkDeviceManifest() {
  const unsigned long now = millis();
  if (
    manifestChecked ||
    WiFi.status() != WL_CONNECTED ||
    now - lastManifestAttemptMs < kManifestRetryIntervalMs
  ) {
    return;
  }

  lastManifestAttemptMs = now;

  HTTPClient http;
  if (strlen(DEVICE_MANIFEST_ROOT_CA) > 0) {
    manifestClient.setCACert(DEVICE_MANIFEST_ROOT_CA);
  } else {
    manifestClient.setInsecure();
  }

  Serial.println("Checking device manifest...");
  Serial.print("Manifest key fingerprint: ");
  Serial.println(summarizeDeviceApiKey());

  if (!http.begin(manifestClient, DEVICE_MANIFEST_URL)) {
    Serial.println("Failed to start manifest request.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-prayerbox-device-key", DEVICE_API_KEY);

  JsonDocument requestDoc;
  requestDoc["deviceId"] = deviceId();
  requestDoc["channel"] = "stable";
  requestDoc["currentVersion"] = kAppVersion;

  String requestBody;
  serializeJson(requestDoc, requestBody);

  const int statusCode = http.POST(requestBody);
  if (statusCode <= 0) {
    Serial.print("Manifest request failed: ");
    Serial.println(http.errorToString(statusCode));
    http.end();
    return;
  }

  Serial.print("Manifest status: ");
  Serial.println(statusCode);

  const String responseBody = http.getString();
  http.end();

  Serial.println("Manifest body:");
  Serial.println(responseBody);

  JsonDocument responseDoc;
  const auto err = deserializeJson(responseDoc, responseBody);
  if (err) {
    Serial.print("Manifest JSON parse failed: ");
    Serial.println(err.c_str());
    return;
  }

  String manifestLatestVersion;
  String manifestFirmwareUrl;
  {
    JsonVariantConst firmwareData = responseDoc["firmware"];
    if (!firmwareData.isNull()) {
      if (firmwareData["version"].is<const char*>()) {
        manifestLatestVersion = firmwareData["version"].as<const char*>();
      }
      if (firmwareData["firmware_url"].is<const char*>()) {
        manifestFirmwareUrl = firmwareData["firmware_url"].as<const char*>();
      }
    }
  }

  manifestChecked = true;
  logManifestResponse(responseDoc);

  const bool updateAvailable =
    manifestLatestVersion.length() > 0 && manifestLatestVersion != kAppVersion;

  Serial.print("AUTO_APPLY_OTA: ");
  Serial.println(AUTO_APPLY_OTA ? "1" : "0");
  Serial.print("Manifest latestVersion: ");
  Serial.println(manifestLatestVersion.length() > 0 ? manifestLatestVersion : "(null)");
  Serial.print("Manifest firmwareUrl: ");
  Serial.println(manifestFirmwareUrl.length() > 0 ? manifestFirmwareUrl : "(null)");
  Serial.print("Update available decision: ");
  Serial.println(updateAvailable ? "true" : "false");
  Serial.print("OTA already attempted: ");
  Serial.println(otaAttempted ? "true" : "false");

  if (updateAvailable && AUTO_APPLY_OTA && !otaAttempted) {
    Serial.println("Entering OTA install branch.");
    otaAttempted = true;
    if (!performOtaUpdate(manifestFirmwareUrl.c_str())) {
      Serial.println("OTA attempt failed.");
    }
  } else {
    Serial.println("Skipping OTA install branch.");
  }
}

bool publishActivation() {
  JsonDocument doc;
  doc["deviceId"] = deviceId();
  doc["groupId"] = DEVICE_GROUP_ID;
  doc["active"] = localActive;
  doc["uptimeMs"] = millis();

  char buffer[256];
  const size_t len = serializeJson(doc, buffer, sizeof(buffer));
  if (len == 0 || len >= sizeof(buffer)) {
    return false;
  }

  const bool published = mqttClient.publish(activationTopic, buffer, false);
  if (published) {
    activationNeedsPublish = false;
    Serial.print("Published activation: ");
    Serial.println(buffer);
  }

  return published;
}

void publishHeartbeat() {
  JsonDocument doc;
  doc["deviceId"] = deviceId();
  doc["groupId"] = DEVICE_GROUP_ID;
  doc["active"] = localActive;
  doc["online"] = true;
  doc["mode"] = lightingModeToString(currentMode);
  doc["uptimeMs"] = millis();
  publishJson(heartbeatTopic, doc, false);
}

void publishOnlineStatus() {
  JsonDocument doc;
  doc["deviceId"] = deviceId();
  doc["groupId"] = DEVICE_GROUP_ID;
  doc["online"] = true;
  doc["uptimeMs"] = millis();
  publishJson(statusTopic, doc, true);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String body;
  body.reserve(length);

  for (unsigned int i = 0; i < length; ++i) {
    body += static_cast<char>(payload[i]);
  }

  if (String(topic) != commandTopic) {
    return;
  }

  body.trim();
  Serial.print("Received group command on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(body);

  if (body.startsWith("{")) {
    JsonDocument doc;
    const auto err = deserializeJson(doc, body);
    if (!err && doc["mode"].is<const char*>()) {
      currentMode = parseLightingMode(doc["mode"].as<String>());
    }
  } else {
    currentMode = parseLightingMode(body);
  }

  Serial.print("Lighting mode is now ");
  Serial.println(lightingModeToString(currentMode));
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print("Connecting to Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("Wi-Fi connected, IP: ");
  Serial.println(WiFi.localIP());
}

bool connectMqtt() {
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512);
  mqttClient.setCallback(mqttCallback);

  if (strlen(MQTT_ROOT_CA) > 0) {
    secureClient.setCACert(MQTT_ROOT_CA);
  } else {
    secureClient.setInsecure();
  }

  JsonDocument offlineDoc;
  offlineDoc["deviceId"] = deviceId();
  offlineDoc["groupId"] = DEVICE_GROUP_ID;
  offlineDoc["online"] = false;
  offlineDoc["uptimeMs"] = millis();

  char offlineBuffer[160];
  serializeJson(offlineDoc, offlineBuffer, sizeof(offlineBuffer));

  Serial.print("Connecting to MQTT");
  const bool connected = mqttClient.connect(
    deviceId(),
    MQTT_USERNAME,
    MQTT_PASSWORD,
    statusTopic,
    1,
    true,
    offlineBuffer
  );

  if (!connected) {
    Serial.print(" failed, rc=");
    Serial.println(mqttClient.state());
    return false;
  }

  Serial.println(" connected");
  mqttClient.subscribe(commandTopic);
  publishOnlineStatus();
  publishHeartbeat();
  publishActivation();
  return true;
}

void flushPendingActivation() {
  if (!activationNeedsPublish || !mqttClient.connected()) {
    return;
  }

  if (!publishActivation()) {
    Serial.println("Activation publish failed, will retry.");
  }
}

void ensureMqtt() {
  if (mqttClient.connected()) {
    flushPendingActivation();
    return;
  }

  const unsigned long now = millis();
  if (now - lastReconnectAttemptMs < kReconnectIntervalMs) {
    return;
  }

  lastReconnectAttemptMs = now;
  ensureWiFi();
  connectMqtt();
}

void handleButton() {
  const unsigned long now = millis();
  const bool reading = digitalRead(BUTTON_PIN);

  if (reading != lastButtonReading) {
    lastDebounceMs = now;
  }

  if (now - lastDebounceMs >= kDebounceMs && reading != stableButtonReading) {
    stableButtonReading = reading;

    if (stableButtonReading == BUTTON_ACTIVE_STATE) {
      localActive = !localActive;
      activationNeedsPublish = true;
      Serial.print("Local active changed to ");
      Serial.println(localActive ? "true" : "false");

      if (mqttClient.connected()) {
        flushPendingActivation();
      }
    }
  }

  lastButtonReading = reading;
}

void buildDeviceIdentity() {
  if (strlen(DEVICE_ID_OVERRIDE) > 0) {
    snprintf(runtimeDeviceId, sizeof(runtimeDeviceId), "%s", DEVICE_ID_OVERRIDE);
    return;
  }

  const unsigned long long chipId = ESP.getEfuseMac();
  snprintf(
    runtimeDeviceId,
    sizeof(runtimeDeviceId),
    "esp32-%012llx",
    chipId
  );
}

void buildTopics() {
  snprintf(commandTopic, sizeof(commandTopic), "groups/%s/lighting_mode", DEVICE_GROUP_ID);
  snprintf(activationTopic, sizeof(activationTopic), "devices/%s/activation", deviceId());
  snprintf(heartbeatTopic, sizeof(heartbeatTopic), "devices/%s/heartbeat", deviceId());
  snprintf(statusTopic, sizeof(statusTopic), "devices/%s/status", deviceId());
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("APP START");
  Serial.println("BUILD MARKER 2026-03-11 A");


  pinMode(LED_PIN, OUTPUT);
#if BUTTON_ACTIVE_STATE == LOW
  pinMode(BUTTON_PIN, INPUT_PULLUP);
#else
  pinMode(BUTTON_PIN, INPUT_PULLDOWN);
#endif
  setOutput(false);

  buildDeviceIdentity();
  buildTopics();
  Serial.print("Device ID: ");
  Serial.println(deviceId());
  lastButtonReading = digitalRead(BUTTON_PIN);
  stableButtonReading = lastButtonReading;

  ensureWiFi();
  connectMqtt();
}

void loop() {
  ensureWiFi();
  checkDeviceManifest();
  ensureMqtt();
  mqttClient.loop();
  flushPendingActivation();

  handleButton();
  updateOutput();

  const unsigned long now = millis();
  if (mqttClient.connected() && now - lastHeartbeatMs >= kHeartbeatIntervalMs) {
    lastHeartbeatMs = now;
    publishHeartbeat();
  }
}
