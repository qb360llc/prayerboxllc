#include <Arduino.h>
#include <DNSServer.h>
#include <ESP.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <mbedtls/sha256.h>
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
constexpr unsigned long kGlowStepIntervalMs = 18;
constexpr unsigned long kDebounceMs = 40;
constexpr unsigned long kManifestRetryIntervalMs = 60000;
constexpr unsigned long kBootstrapRetryIntervalMs = 30000;
constexpr unsigned long kWiFiConnectTimeoutMs = 20000;
constexpr unsigned long kProvisioningHoldMs = 5000;
constexpr unsigned long kProvisioningBlinkIntervalMs = 200;
constexpr unsigned long kWiFiConnectingBlinkIntervalMs = 700;
constexpr unsigned long kWiFiFailureBlinkIntervalMs = 180;
constexpr unsigned long kSuccessBlinkIntervalMs = 120;
constexpr uint8_t kSuccessBlinkCount = 3;
constexpr uint8_t kPwmChannel = 0;
constexpr uint8_t kPwmResolutionBits = 8;
constexpr uint32_t kPwmFrequencyHz = 5000;
constexpr uint8_t kPwmMaxDuty = (1 << kPwmResolutionBits) - 1;
constexpr uint8_t kGlowMinDuty = 56;
constexpr uint8_t kGlowMaxDuty = 176;
constexpr uint8_t kGlowDutyStep = 4;
constexpr const char* kPreferencesNamespace = "prayerbox";
constexpr const char* kDeviceKeyPref = "device_key";
constexpr const char* kGroupIdPref = "group_id";
constexpr const char* kWifiSsidPref = "wifi_ssid";
constexpr const char* kWifiPassPref = "wifi_pass";
#ifdef APP_VERSION
constexpr const char* kAppVersion = APP_VERSION;
#else
constexpr const char* kAppVersion = "0.0.0";
#endif

DNSServer dnsServer;
WebServer provisioningServer(80);
WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);
WiFiClientSecure manifestClient;
WiFiClientSecure otaClient;
WiFiClientSecure bootstrapClient;
Preferences preferences;

LightingMode currentMode = LightingMode::Off;
bool localActive = false;
bool lastButtonReading = false;
bool stableButtonReading = false;
bool activationNeedsPublish = true;
bool manifestChecked = false;
bool otaAttempted = false;
bool bootstrapComplete = false;
bool hasStoredDeviceApiKey = false;
bool provisioningMode = false;
bool provisioningServerInitialized = false;
bool longPressHandled = false;
bool provisioningLedState = false;
bool wifiConnectingLedState = false;
bool wifiFailureLedState = false;
bool glowIncreasing = true;

unsigned long lastHeartbeatMs = 0;
unsigned long lastReconnectAttemptMs = 0;
unsigned long lastDebounceMs = 0;
unsigned long lastManifestAttemptMs = 0;
unsigned long lastBootstrapAttemptMs = 0;
unsigned long buttonPressedMs = 0;
unsigned long lastProvisioningBlinkMs = 0;
unsigned long lastWiFiConnectingBlinkMs = 0;
unsigned long lastGlowStepMs = 0;

char commandTopic[96];
char activationTopic[96];
char heartbeatTopic[96];
char statusTopic[96];
char runtimeDeviceId[32];
char runtimeDeviceApiKey[80];
char runtimeGroupId[64];
char runtimeWifiSsid[64];
char runtimeWifiPassword[80];
char provisioningApSsid[48];

void buildTopics();
void publishHeartbeat();
void publishOnlineStatus();
void flushPendingActivation();
void refreshTopicsForGroupChange(const String& nextGroupId);
void startProvisioningPortal(const char* reason);
void serviceProvisioningPortal();
void blinkLedPattern(unsigned long intervalMs, uint8_t flashes);
void setOutputDuty(uint8_t duty);

const char* deviceId() {
  return runtimeDeviceId;
}

const char* activeDeviceApiKey() {
  return hasStoredDeviceApiKey ? runtimeDeviceApiKey : DEVICE_API_KEY;
}

const char* activeGroupId() {
  return runtimeGroupId[0] != '\0' ? runtimeGroupId : DEVICE_GROUP_ID;
}

const char* activeWiFiSsid() {
  return runtimeWifiSsid[0] != '\0' ? runtimeWifiSsid : WIFI_SSID;
}

const char* activeWiFiPassword() {
  return runtimeWifiPassword[0] != '\0' ? runtimeWifiPassword : WIFI_PASSWORD;
}

String summarizeDeviceApiKey() {
  const char* apiKey = activeDeviceApiKey();
  const size_t keyLength = strlen(apiKey);
  if (keyLength == 0) {
    return "empty";
  }

  const size_t visibleChars = keyLength < 8 ? keyLength : 8;
  String summary = String(apiKey).substring(0, visibleChars);
  summary += "... (len=";
  summary += keyLength;
  summary += ")";
  return summary;
}

String normalizeSha256(const String& input) {
  String normalized = input;
  normalized.trim();
  normalized.toLowerCase();
  return normalized;
}

bool isValidSha256Hex(const String& input) {
  if (input.length() != 64) {
    return false;
  }

  for (size_t i = 0; i < input.length(); ++i) {
    const char ch = input[i];
    const bool isHex =
      (ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'f');
    if (!isHex) {
      return false;
    }
  }

  return true;
}

String sha256DigestToHex(const unsigned char* digest, size_t digestLength) {
  static constexpr char kHex[] = "0123456789abcdef";
  String output;
  output.reserve(digestLength * 2);

  for (size_t i = 0; i < digestLength; ++i) {
    output += kHex[(digest[i] >> 4) & 0x0F];
    output += kHex[digest[i] & 0x0F];
  }

  return output;
}

bool saveDeviceApiKey(const String& apiKey) {
  if (apiKey.length() == 0 || apiKey.length() >= sizeof(runtimeDeviceApiKey)) {
    return false;
  }

  preferences.begin(kPreferencesNamespace, false);
  const size_t written = preferences.putString(kDeviceKeyPref, apiKey);
  preferences.end();
  if (written == 0) {
    return false;
  }

  snprintf(runtimeDeviceApiKey, sizeof(runtimeDeviceApiKey), "%s", apiKey.c_str());
  hasStoredDeviceApiKey = true;
  return true;
}

void loadDeviceApiKey() {
  runtimeDeviceApiKey[0] = '\0';
  preferences.begin(kPreferencesNamespace, true);
  const String storedKey = preferences.getString(kDeviceKeyPref, "");
  preferences.end();

  if (storedKey.length() == 0 || storedKey.length() >= sizeof(runtimeDeviceApiKey)) {
    hasStoredDeviceApiKey = false;
    return;
  }

  snprintf(runtimeDeviceApiKey, sizeof(runtimeDeviceApiKey), "%s", storedKey.c_str());
  hasStoredDeviceApiKey = true;
}

bool saveGroupId(const String& groupId) {
  if (groupId.length() == 0 || groupId.length() >= sizeof(runtimeGroupId)) {
    return false;
  }

  preferences.begin(kPreferencesNamespace, false);
  const size_t written = preferences.putString(kGroupIdPref, groupId);
  preferences.end();
  if (written == 0) {
    return false;
  }

  snprintf(runtimeGroupId, sizeof(runtimeGroupId), "%s", groupId.c_str());
  return true;
}

void loadGroupId() {
  snprintf(runtimeGroupId, sizeof(runtimeGroupId), "%s", DEVICE_GROUP_ID);
  preferences.begin(kPreferencesNamespace, true);
  const String storedGroup = preferences.getString(kGroupIdPref, DEVICE_GROUP_ID);
  preferences.end();

  if (storedGroup.length() == 0 || storedGroup.length() >= sizeof(runtimeGroupId)) {
    return;
  }

  snprintf(runtimeGroupId, sizeof(runtimeGroupId), "%s", storedGroup.c_str());
}

bool saveWiFiCredentials(const String& ssid, const String& password) {
  if (ssid.length() == 0 || ssid.length() >= sizeof(runtimeWifiSsid) || password.length() >= sizeof(runtimeWifiPassword)) {
    return false;
  }

  preferences.begin(kPreferencesNamespace, false);
  const size_t ssidWritten = preferences.putString(kWifiSsidPref, ssid);
  const size_t passwordWritten = preferences.putString(kWifiPassPref, password);
  preferences.end();

  if (ssidWritten == 0 || (password.length() > 0 && passwordWritten == 0)) {
    return false;
  }

  snprintf(runtimeWifiSsid, sizeof(runtimeWifiSsid), "%s", ssid.c_str());
  snprintf(runtimeWifiPassword, sizeof(runtimeWifiPassword), "%s", password.c_str());
  return true;
}

void loadWiFiCredentials() {
  runtimeWifiSsid[0] = '\0';
  runtimeWifiPassword[0] = '\0';

  preferences.begin(kPreferencesNamespace, true);
  const String storedSsid = preferences.getString(kWifiSsidPref, "");
  const String storedPassword = preferences.getString(kWifiPassPref, "");
  preferences.end();

  if (storedSsid.length() == 0 || storedSsid.length() >= sizeof(runtimeWifiSsid) || storedPassword.length() >= sizeof(runtimeWifiPassword)) {
    return;
  }

  snprintf(runtimeWifiSsid, sizeof(runtimeWifiSsid), "%s", storedSsid.c_str());
  snprintf(runtimeWifiPassword, sizeof(runtimeWifiPassword), "%s", storedPassword.c_str());
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

void setOutputDuty(uint8_t duty) {
  const uint8_t adjustedDuty = LED_ACTIVE_HIGH ? duty : (kPwmMaxDuty - duty);
  ledcWrite(kPwmChannel, adjustedDuty);
}

void setOutput(bool on) {
  setOutputDuty(on ? kPwmMaxDuty : 0);
}

void blinkLedPattern(unsigned long intervalMs, uint8_t flashes) {
  for (uint8_t i = 0; i < flashes; ++i) {
    setOutput(true);
    delay(intervalMs);
    setOutput(false);
    delay(intervalMs);
  }
}

void updateOutput() {
  const unsigned long now = millis();

  switch (currentMode) {
    case LightingMode::Off:
      setOutputDuty(0);
      break;
    case LightingMode::Solid:
      setOutputDuty(kPwmMaxDuty);
      break;
    case LightingMode::Flash:
      if (now - lastGlowStepMs >= kGlowStepIntervalMs) {
        lastGlowStepMs = now;
        static uint8_t glowDuty = kGlowMinDuty;
        if (glowIncreasing) {
          glowDuty = min<uint8_t>(kGlowMaxDuty, glowDuty + kGlowDutyStep);
          if (glowDuty >= kGlowMaxDuty) {
            glowIncreasing = false;
          }
        } else {
          glowDuty = max<uint8_t>(kGlowMinDuty, glowDuty - kGlowDutyStep);
          if (glowDuty <= kGlowMinDuty) {
            glowIncreasing = true;
          }
        }
        setOutputDuty(glowDuty);
      }
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

String htmlEscape(const String& input) {
  String output;
  output.reserve(input.length() + 16);

  for (size_t i = 0; i < input.length(); ++i) {
    const char ch = input[i];
    switch (ch) {
      case '&':
        output += "&amp;";
        break;
      case '<':
        output += "&lt;";
        break;
      case '>':
        output += "&gt;";
        break;
      case '"':
        output += "&quot;";
        break;
      case '\'':
        output += "&#39;";
        break;
      default:
        output += ch;
        break;
    }
  }

  return output;
}

String provisioningPage() {
  String options;
  const int networkCount = WiFi.scanNetworks(false, true);
  for (int i = 0; i < networkCount; ++i) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) {
      continue;
    }
    options += "<option value=\"";
    options += htmlEscape(ssid);
    options += "\"></option>";
  }
  WiFi.scanDelete();

  String page;
  page.reserve(4096);
  page += F(
    "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>PRayerbox Wi-Fi Setup</title>"
    "<style>"
    "body{font-family:Arial,sans-serif;background:#f3efe4;color:#1b1a17;margin:0;padding:24px;}"
    ".card{max-width:560px;margin:0 auto;background:#fffaf0;padding:24px;border-radius:18px;box-shadow:0 14px 40px rgba(27,26,23,.08);}"
    "h1{margin:0 0 10px;font-size:2rem;}p{line-height:1.5;color:#6f675d;}label{display:block;margin:16px 0 6px;font-weight:600;}"
    "input{width:100%;padding:14px;border:1px solid #d8cfbf;border-radius:12px;font-size:1rem;box-sizing:border-box;}"
    "button{margin-top:18px;padding:14px 18px;border:0;border-radius:999px;background:#0d6b57;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;width:100%;}"
    ".meta{margin-top:18px;font-size:.95rem;color:#6f675d;}.chip{display:inline-block;padding:6px 10px;border-radius:999px;background:#e4f0ec;color:#084c3e;font-weight:700;margin-top:8px;}"
    "</style></head><body><div class='card'>"
  );
  page += "<h1>PRayerbox Wi-Fi Setup</h1>";
  page += "<p>Connect this device to your home's Wi-Fi. After saving, the box will restart and reconnect on its own.</p>";
  page += "<div class='chip'>";
  page += htmlEscape(deviceId());
  page += "</div>";
  page += "<div class='meta'>Setup network: <strong>";
  page += htmlEscape(provisioningApSsid);
  page += "</strong><br>Open <strong>http://192.168.4.1</strong> if this page does not appear automatically.</div>";
  page += "<form method='post' action='/save'>";
  page += "<label for='ssid'>Wi-Fi name</label>";
  page += "<input id='ssid' name='ssid' list='ssid-list' value='";
  page += htmlEscape(activeWiFiSsid());
  page += "' placeholder='Your Wi-Fi network' required>";
  page += "<datalist id='ssid-list'>";
  page += options;
  page += "</datalist>";
  page += "<label for='password'>Wi-Fi password</label>";
  page += "<input id='password' name='password' type='password' value='";
  page += htmlEscape(activeWiFiPassword());
  page += "' placeholder='Wi-Fi password'>";
  page += "<button type='submit'>Save and Restart</button>";
  page += "</form></div></body></html>";
  return page;
}

void handleProvisioningRoot() {
  provisioningServer.send(200, "text/html", provisioningPage());
}

void handleProvisioningSave() {
  const String ssid = provisioningServer.arg("ssid");
  const String password = provisioningServer.arg("password");

  if (!saveWiFiCredentials(ssid, password)) {
    provisioningServer.send(400, "text/html",
      "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
      "<body style='font-family:Arial,sans-serif;background:#f3efe4;padding:24px;color:#1b1a17;'>"
      "<div style='max-width:520px;margin:0 auto;background:#fffaf0;padding:24px;border-radius:18px;'>"
      "<h1 style='margin-top:0;'>Could not save</h1>"
      "<p>Check the Wi-Fi name and try again. The PRayerbox setup network will stay available.</p>"
      "</div></body></html>");
    blinkLedPattern(kWiFiFailureBlinkIntervalMs, 2);
    return;
  }

  provisioningServer.send(200, "text/html",
    "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
    "<body style='font-family:Arial,sans-serif;background:#f3efe4;padding:24px;color:#1b1a17;'>"
    "<div style='max-width:520px;margin:0 auto;background:#fffaf0;padding:24px;border-radius:18px;'>"
    "<h1 style='margin-top:0;'>Saved</h1>"
    "<p>Your Wi-Fi settings were saved. This PRayerbox will blink three times, then restart and reconnect.</p>"
    "</div></body></html>");
  blinkLedPattern(kSuccessBlinkIntervalMs, kSuccessBlinkCount);
  delay(1200);
  ESP.restart();
}

void initializeProvisioningServer() {
  if (provisioningServerInitialized) {
    return;
  }

  provisioningServer.on("/", HTTP_GET, handleProvisioningRoot);
  provisioningServer.on("/generate_204", HTTP_GET, handleProvisioningRoot);
  provisioningServer.on("/hotspot-detect.html", HTTP_GET, handleProvisioningRoot);
  provisioningServer.on("/save", HTTP_POST, handleProvisioningSave);
  provisioningServer.onNotFound(handleProvisioningRoot);
  provisioningServer.begin();
  provisioningServerInitialized = true;
}

void startProvisioningPortal(const char* reason) {
  if (provisioningMode) {
    return;
  }

  snprintf(
    provisioningApSsid,
    sizeof(provisioningApSsid),
    "%s-%s",
    WIFI_SETUP_AP_PREFIX,
    strlen(deviceId()) >= 4 ? deviceId() + strlen(deviceId()) - 4 : deviceId()
  );

  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_AP_STA);
  const bool apStarted =
    strlen(WIFI_SETUP_AP_PASSWORD) >= 8
      ? WiFi.softAP(provisioningApSsid, WIFI_SETUP_AP_PASSWORD)
      : WiFi.softAP(provisioningApSsid);

  if (!apStarted) {
    Serial.println("Failed to start provisioning access point.");
    return;
  }

  dnsServer.start(53, "*", WiFi.softAPIP());
  initializeProvisioningServer();
  provisioningMode = true;
  provisioningLedState = false;
  lastProvisioningBlinkMs = 0;

  Serial.println();
  Serial.println("Entering Wi-Fi provisioning mode.");
  Serial.print("Reason: ");
  Serial.println(reason);
  Serial.print("Setup SSID: ");
  Serial.println(provisioningApSsid);
  Serial.print("Portal IP: ");
  Serial.println(WiFi.softAPIP());
}

void serviceProvisioningPortal() {
  dnsServer.processNextRequest();
  provisioningServer.handleClient();

  const unsigned long now = millis();
  if (now - lastProvisioningBlinkMs >= kProvisioningBlinkIntervalMs) {
    lastProvisioningBlinkMs = now;
    provisioningLedState = !provisioningLedState;
    setOutput(provisioningLedState);
  }
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

  void refreshTopicsForGroupChange(const String& nextGroupId) {
    if (
      nextGroupId.length() == 0 ||
      nextGroupId.length() >= sizeof(runtimeGroupId) ||
      nextGroupId == activeGroupId()
    ) {
      return;
    }

    char previousCommandTopic[sizeof(commandTopic)];
    snprintf(previousCommandTopic, sizeof(previousCommandTopic), "%s", commandTopic);

    if (!saveGroupId(nextGroupId)) {
      Serial.println("Failed to persist manifest group.");
      return;
    }

    buildTopics();
    Serial.print("Switched runtime group to ");
    Serial.println(activeGroupId());

    if (mqttClient.connected()) {
      mqttClient.unsubscribe(previousCommandTopic);
      mqttClient.subscribe(commandTopic);
      activationNeedsPublish = true;
      publishOnlineStatus();
      publishHeartbeat();
      flushPendingActivation();
    }
  }

  void checkDeviceBootstrap() {
#ifndef DEVICE_BOOTSTRAP_URL
  return;
#else
  const unsigned long now = millis();
  if (
    bootstrapComplete ||
    hasStoredDeviceApiKey ||
    strlen(DEVICE_BOOTSTRAP_URL) == 0 ||
    WiFi.status() != WL_CONNECTED ||
    now - lastBootstrapAttemptMs < kBootstrapRetryIntervalMs
  ) {
    return;
  }

  lastBootstrapAttemptMs = now;

  HTTPClient http;
  if (strlen(DEVICE_MANIFEST_ROOT_CA) > 0) {
    bootstrapClient.setCACert(DEVICE_MANIFEST_ROOT_CA);
  } else {
    bootstrapClient.setInsecure();
  }

  Serial.println("Checking device bootstrap...");
  if (!http.begin(bootstrapClient, DEVICE_BOOTSTRAP_URL)) {
    Serial.println("Failed to start bootstrap request.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-prayerbox-bootstrap-key", DEVICE_API_KEY);

  JsonDocument requestDoc;
  requestDoc["deviceId"] = deviceId();

  String requestBody;
  serializeJson(requestDoc, requestBody);

  const int statusCode = http.POST(requestBody);
  if (statusCode <= 0) {
    Serial.print("Bootstrap request failed: ");
    Serial.println(http.errorToString(statusCode));
    http.end();
    return;
  }

  const String responseBody = http.getString();
  http.end();

  Serial.print("Bootstrap status: ");
  Serial.println(statusCode);
  if (statusCode != HTTP_CODE_OK) {
    Serial.println(responseBody);
    return;
  }

  JsonDocument responseDoc;
  const auto err = deserializeJson(responseDoc, responseBody);
  if (err) {
    Serial.print("Bootstrap JSON parse failed: ");
    Serial.println(err.c_str());
    return;
  }

  const char* bootstrapKey = responseDoc["bootstrap"]["deviceApiKey"] | "";
  if (strlen(bootstrapKey) == 0) {
    Serial.println("Bootstrap response missing device API key.");
    return;
  }

  if (!saveDeviceApiKey(String(bootstrapKey))) {
    Serial.println("Failed to persist device API key.");
    return;
  }

  bootstrapComplete = true;
  manifestChecked = false;
  lastManifestAttemptMs = 0;
  Serial.println("Stored per-device API key in NVS.");
#endif
}

bool performOtaUpdate(const char* firmwareUrl, const char* expectedChecksum) {
  if (!firmwareUrl || strlen(firmwareUrl) == 0) {
    Serial.println("Skipping OTA: manifest did not provide a firmware URL.");
    return false;
  }

  const String expectedSha256 = normalizeSha256(expectedChecksum ? expectedChecksum : "");
  if (!isValidSha256Hex(expectedSha256)) {
    Serial.println("Skipping OTA: manifest did not provide a valid SHA-256 checksum.");
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
  mbedtls_sha256_context sha256Ctx;
  mbedtls_sha256_init(&sha256Ctx);
  if (mbedtls_sha256_starts_ret(&sha256Ctx, 0) != 0) {
    Serial.println("Failed to initialize SHA-256 context.");
    http.end();
    return false;
  }

  static constexpr size_t kOtaBufferSize = 1024;
  uint8_t buffer[kOtaBufferSize];
  size_t written = 0;
  int remaining = contentLength;

  while (http.connected() && remaining > 0) {
    const size_t available = stream.available();
    if (available == 0) {
      delay(1);
      continue;
    }

    const size_t toRead = min(
      static_cast<size_t>(remaining),
      min(available, kOtaBufferSize)
    );
    const size_t bytesRead = stream.readBytes(buffer, toRead);
    if (bytesRead == 0) {
      delay(1);
      continue;
    }

    if (Update.write(buffer, bytesRead) != bytesRead) {
      Serial.print("OTA write failed: ");
      Serial.println(Update.errorString());
      mbedtls_sha256_free(&sha256Ctx);
      Update.abort();
      http.end();
      return false;
    }

    if (mbedtls_sha256_update_ret(&sha256Ctx, buffer, bytesRead) != 0) {
      Serial.println("Failed to update OTA SHA-256 digest.");
      mbedtls_sha256_free(&sha256Ctx);
      Update.abort();
      http.end();
      return false;
    }

    written += bytesRead;
    remaining -= bytesRead;
  }

  if (written != static_cast<size_t>(contentLength)) {
    Serial.print("OTA wrote ");
    Serial.print(written);
    Serial.print(" of ");
    Serial.print(contentLength);
    Serial.println(" bytes.");
    mbedtls_sha256_free(&sha256Ctx);
    Update.abort();
    http.end();
    return false;
  }

  unsigned char digest[32];
  if (mbedtls_sha256_finish_ret(&sha256Ctx, digest) != 0) {
    Serial.println("Failed to finalize OTA SHA-256 digest.");
    mbedtls_sha256_free(&sha256Ctx);
    Update.abort();
    http.end();
    return false;
  }
  mbedtls_sha256_free(&sha256Ctx);

  const String actualSha256 = sha256DigestToHex(digest, sizeof(digest));
  Serial.print("Expected OTA SHA-256: ");
  Serial.println(expectedSha256);
  Serial.print("Actual OTA SHA-256: ");
  Serial.println(actualSha256);

  if (actualSha256 != expectedSha256) {
    Serial.println("OTA checksum mismatch. Rejecting update.");
    Update.abort();
    http.end();
    return false;
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
    http.addHeader("x-prayerbox-device-key", activeDeviceApiKey());

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

    String manifestGroupId;
    String manifestLatestVersion;
    String manifestFirmwareUrl;
    String manifestChecksumSha256;

    {
      JsonVariantConst deviceData = responseDoc["device"];
      if (!deviceData.isNull() && deviceData["groupId"].is<const char*>()) {
        manifestGroupId = deviceData["groupId"].as<const char*>();
      }
    }

    {
      JsonVariantConst firmwareData = responseDoc["firmware"];
      if (!firmwareData.isNull()) {
        if (firmwareData["version"].is<const char*>()) {
          manifestLatestVersion = firmwareData["version"].as<const char*>();
        }
        if (firmwareData["firmware_url"].is<const char*>()) {
          manifestFirmwareUrl = firmwareData["firmware_url"].as<const char*>();
        }
        if (firmwareData["checksum_sha256"].is<const char*>()) {
          manifestChecksumSha256 = firmwareData["checksum_sha256"].as<const char*>();
        }
      }
    }

    manifestChecked = true;
    if (manifestGroupId.length() > 0) {
      refreshTopicsForGroupChange(manifestGroupId);
    }
    logManifestResponse(responseDoc);

    const bool updateAvailable =
      manifestLatestVersion.length() > 0 && manifestLatestVersion != kAppVersion;

    Serial.print("AUTO_APPLY_OTA: ");
    Serial.println(AUTO_APPLY_OTA ? "1" : "0");
    Serial.print("Manifest latestVersion: ");
    Serial.println(manifestLatestVersion.length() > 0 ? manifestLatestVersion : "(null)");
    Serial.print("Manifest firmwareUrl: ");
    Serial.println(manifestFirmwareUrl.length() > 0 ? manifestFirmwareUrl : "(null)");
    Serial.print("Manifest checksumSha256: ");
    Serial.println(manifestChecksumSha256.length() > 0 ? manifestChecksumSha256 : "(null)");
    Serial.print("Update available decision: ");
    Serial.println(updateAvailable ? "true" : "false");
    Serial.print("OTA already attempted: ");
    Serial.println(otaAttempted ? "true" : "false");

    if (updateAvailable && AUTO_APPLY_OTA && !otaAttempted) {
      Serial.println("Entering OTA install branch.");
      otaAttempted = true;
      if (!performOtaUpdate(manifestFirmwareUrl.c_str(), manifestChecksumSha256.c_str())) {
        Serial.println("OTA attempt failed.");
      }
    } else {
      Serial.println("Skipping OTA install branch.");
    }
  }

  bool publishActivation() {
    JsonDocument doc;
    doc["deviceId"] = deviceId();
    doc["groupId"] = activeGroupId();
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
    doc["groupId"] = activeGroupId();
    doc["active"] = localActive;
  doc["online"] = true;
  doc["mode"] = lightingModeToString(currentMode);
  doc["uptimeMs"] = millis();
  publishJson(heartbeatTopic, doc, false);
}

  void publishOnlineStatus() {
    JsonDocument doc;
    doc["deviceId"] = deviceId();
    doc["groupId"] = activeGroupId();
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

bool ensureWiFi() {
  if (provisioningMode) {
    return false;
  }

  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  Serial.print("Connecting to Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(activeWiFiSsid(), activeWiFiPassword());

  const unsigned long connectStartedMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - connectStartedMs < kWiFiConnectTimeoutMs) {
    const unsigned long now = millis();
    if (now - lastWiFiConnectingBlinkMs >= kWiFiConnectingBlinkIntervalMs) {
      lastWiFiConnectingBlinkMs = now;
      wifiConnectingLedState = !wifiConnectingLedState;
      setOutput(wifiConnectingLedState);
    }
    delay(120);
    Serial.print(".");
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println();
    for (uint8_t i = 0; i < 4; ++i) {
      wifiFailureLedState = !wifiFailureLedState;
      setOutput(wifiFailureLedState);
      delay(kWiFiFailureBlinkIntervalMs);
    }
    setOutput(false);
    startProvisioningPortal("wifi connect timeout");
    return false;
  }

  Serial.println();
  Serial.print("Wi-Fi connected, IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Connected SSID: ");
  Serial.println(WiFi.SSID());
  setOutput(true);
  delay(250);
  setOutput(false);
  return true;
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
    offlineDoc["groupId"] = activeGroupId();
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
  if (!ensureWiFi()) {
    return;
  }
  connectMqtt();
}

void handleButton() {
  if (provisioningMode) {
    return;
  }

  const unsigned long now = millis();
  const bool reading = digitalRead(BUTTON_PIN);

  if (reading != lastButtonReading) {
    lastDebounceMs = now;
  }

  if (now - lastDebounceMs >= kDebounceMs && reading != stableButtonReading) {
    stableButtonReading = reading;

    if (stableButtonReading == BUTTON_ACTIVE_STATE) {
      buttonPressedMs = now;
      longPressHandled = false;
    } else {
      if (!longPressHandled) {
        localActive = !localActive;
        activationNeedsPublish = true;
        Serial.print("Local active changed to ");
        Serial.println(localActive ? "true" : "false");

        if (mqttClient.connected()) {
          flushPendingActivation();
        }
      }
      buttonPressedMs = 0;
    }
  }

  if (
    stableButtonReading == BUTTON_ACTIVE_STATE &&
    buttonPressedMs != 0 &&
    !longPressHandled &&
    now - buttonPressedMs >= kProvisioningHoldMs
  ) {
    longPressHandled = true;
    startProvisioningPortal("button hold");
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
    snprintf(commandTopic, sizeof(commandTopic), "groups/%s/lighting_mode", activeGroupId());
    snprintf(activationTopic, sizeof(activationTopic), "devices/%s/activation", deviceId());
  snprintf(heartbeatTopic, sizeof(heartbeatTopic), "devices/%s/heartbeat", deviceId());
  snprintf(statusTopic, sizeof(statusTopic), "devices/%s/status", deviceId());
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("APP START");

  ledcSetup(kPwmChannel, kPwmFrequencyHz, kPwmResolutionBits);
  ledcAttachPin(LED_PIN, kPwmChannel);
#if BUTTON_ACTIVE_STATE == LOW
  pinMode(BUTTON_PIN, INPUT_PULLUP);
#else
  pinMode(BUTTON_PIN, INPUT_PULLDOWN);
#endif
  setOutput(false);

  buildDeviceIdentity();
  loadDeviceApiKey();
  loadGroupId();
  loadWiFiCredentials();
  buildTopics();
  Serial.print("Device ID: ");
  Serial.println(deviceId());
  Serial.print("Device API key source: ");
  Serial.println(hasStoredDeviceApiKey ? "stored" : "bootstrap");
  Serial.print("Initial group: ");
  Serial.println(activeGroupId());
  Serial.print("Wi-Fi credential source: ");
  Serial.println(runtimeWifiSsid[0] != '\0' ? "stored" : "default");
  Serial.print("Active Wi-Fi SSID: ");
  Serial.println(activeWiFiSsid());
  lastButtonReading = digitalRead(BUTTON_PIN);
  stableButtonReading = lastButtonReading;

  if (stableButtonReading == BUTTON_ACTIVE_STATE) {
    const unsigned long holdStartedMs = millis();
    while (digitalRead(BUTTON_PIN) == BUTTON_ACTIVE_STATE && millis() - holdStartedMs < kProvisioningHoldMs) {
      delay(20);
    }

    if (digitalRead(BUTTON_PIN) == BUTTON_ACTIVE_STATE) {
      startProvisioningPortal("startup button hold");
      return;
    }
  }

  ensureWiFi();
  connectMqtt();
}

void loop() {
  if (provisioningMode) {
    serviceProvisioningPortal();
    return;
  }

  ensureWiFi();
  if (provisioningMode) {
    return;
  }
  checkDeviceBootstrap();
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
