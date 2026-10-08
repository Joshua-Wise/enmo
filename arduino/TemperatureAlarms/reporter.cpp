#include "reporter.h"

#include <Arduino.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>

#include "config.h"
#include "network.h"
#include "server.h"
#include "updater.h"
#include "version.h"

static const char READINGS_PATH[] = "/api/readings";
// How much of a refusal's body is read for the log, and for how long in all. HTTPClient's own
// getString() reads everything the server sends, waiting up to the timeout per byte, so a server
// that trickles a byte at a time would hold the loop for good.
static const size_t RESPONSE_LOG_MAX = 120;
static const unsigned long RESPONSE_READ_MS = 2 * 1000UL;

// Text for the JSON: printable ASCII only, without quotes or backslashes, so it never breaks the body.
static String jsonText(const String& text) {
  String clean;
  clean.reserve(text.length());
  for (char c : text) {
    if (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') clean += c;
  }
  return clean;
}

// What the board says about itself for the Firmware tab (backend deviceInfo.ts), after the opening
// fields of a Reading or a fault report: version, WiFi signal, uptime, free memory, why it last
// restarted, its last update check, which sensor it carries, and which WiFi network it is on (its
// SSID, and 1 or 2: the second is its fallback network, a note on its card). Closes the JSON object.
static void appendSelfReport(String& json) {
  json += F(",\"fw\":");
  json += FIRMWARE_VERSION;
  json += F(",\"rssi\":");
  json += WiFi.RSSI();
  json += F(",\"uptime\":");
  json += millis() / 1000;
  json += F(",\"heap\":");
  json += ESP.getFreeHeap();
  json += F(",\"reset\":\"");
  json += jsonText(ESP.getResetReason());
  json += F("\",\"update\":\"");
  json += jsonText(updaterLastResult());
  json += F("\",\"sensor\":\"");
  json += sensorType();
  json += F("\",\"ssid\":\"");
  json += jsonText(networkSsid());
  json += F("\",\"network\":");
  json += networkNumber();
  json += '}';
}

static String readingJson(const char* hostname, const Sample& sample) {
  String json;
  json.reserve(304);
  json += F("{\"device\":\"");
  json += hostname;
  json += F("\",\"temp\":");
  json += String(sample.tempF, 1);
  json += F(",\"humidity\":");
  json += String(sample.humidity, 0);
  appendSelfReport(json);
  return json;
}

// A fault report: the sensor did not answer, so there are no values to send.
static String faultJson(const char* hostname) {
  String json;
  json.reserve(288);
  json += F("{\"device\":\"");
  json += hostname;
  json += F("\",\"fault\":\"sensor\"");
  appendSelfReport(json);
  return json;
}

// The start of the response body, printable ASCII only, so a server cannot write a line of its own
// (a fake `report: 201 created`, say) into the serial log the bench reads.
static String responseStart(WiFiClient& client) {
  String text;
  text.reserve(RESPONSE_LOG_MAX);
  unsigned long startedAt = millis();
  while (text.length() < RESPONSE_LOG_MAX && millis() - startedAt < RESPONSE_READ_MS) {
    int c = client.read();
    if (c < 0) {
      if (!client.connected()) break;
      delay(10);
      continue;
    }
    if (c >= 0x20 && c < 0x7f) text += (char)c;
  }
  return text;
}

// One POST over the given client. Returns the HTTP status, or a negative HTTPClient error.
// Redirects stay off (HTTPClient's default): the token goes only to SERVER_URL. `accepted` is the
// status that means success: 201 for a Reading, 202 for a fault report.
static int post(WiFiClient& client, const String& body, int accepted, String& response) {
  HTTPClient http;
  http.setTimeout(SERVER_TIMEOUT_MS);
  http.setReuse(false);
  if (!http.begin(client, serverUrl(READINGS_PATH))) return HTTPC_ERROR_CONNECTION_FAILED;
  http.addHeader(F("Content-Type"), F("application/json"));
  http.addHeader(F("Authorization"), F("Bearer " DEVICE_TOKEN));  // one string in flash, built at compile time
  // The server names a newer build waiting for this board in a header, so the board checks at once.
  // An absent header reads as "", which is 0: none waiting.
  const char* wanted[] = {"X-Firmware-Available"};
  http.collectHeaders(wanted, 1);
  int status = http.POST(body);
  if (status == accepted) updaterOffered(http.header("X-Firmware-Available").toInt());
  if (status > 0 && status != accepted) response = responseStart(client);
  http.end();
  return status;
}

void reporterBegin() {
  Serial.print(F("report: every "));
  Serial.print(REPORT_INTERVAL_SECONDS);
  Serial.print(F(" s to "));
  Serial.println(serverUrl(READINGS_PATH));
}

// Whether the server took the report, as far as moving to the other server goes: no answer, the token
// refused, the Device unknown there, or a server error is not; a refusal of the values (422) or the
// rate limit (429) is the server working.
static bool taken(int status, int accepted) {
  return status == accepted || (status > 0 && status != HTTP_CODE_UNAUTHORIZED && status != HTTP_CODE_NOT_FOUND && status < 500);
}

// POSTs the body once and logs the outcome: `success` when the server answers `accepted`.
static void send(const String& body, int accepted, const __FlashStringHelper* success) {
  String response;
  int status = 0;
  const __FlashStringHelper* problem =
      serverRequest([&](WiFiClient& client) { status = post(client, body, accepted, response); });
  if (problem != nullptr) {
    Serial.print(F("report: failed, "));
    Serial.print(problem);
    Serial.println(F(", token not sent"));
    serverReportTaken(false);
    return;
  }
  serverReportTaken(taken(status, accepted));

  if (status == accepted) {
    Serial.println(success);
    return;
  }
  if (status < 0) {
    Serial.print(F("report: failed, "));
    Serial.println(HTTPClient::errorToString(status));
  } else {
    Serial.print(F("report: "));
    Serial.print(status);
    Serial.print(' ');
    Serial.println(response);
  }
}

void reportReading(const char* hostname, const Sample& sample) {
  send(readingJson(hostname, sample), HTTP_CODE_CREATED, F("report: 201 created"));
}

void reportFault(const char* hostname) {
  send(faultJson(hostname), HTTP_CODE_ACCEPTED, F("report: 202 sensor fault reported"));
}
