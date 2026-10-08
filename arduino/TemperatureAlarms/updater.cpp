#include "updater.h"

#include <Arduino.h>
#include <ESP8266httpUpdate.h>

#include "config.h"
#include "network.h"
#include "server.h"
#include "version.h"

// The build writes Updater_Signing.h, with ARDUINO_SIGNING 1, when public.key is in the sketch
// folder; the core's Updater then refuses any image not signed with the matching private.key. A
// build without it would install whatever the server sent, so it never checks for updates at all.
#if __has_include(<Updater_Signing.h>)
#include <Updater_Signing.h>
#endif
#ifndef ARDUINO_SIGNING
#define ARDUINO_SIGNING 0
#endif

#define STRINGIFY_(x) #x
#define STRINGIFY(x) STRINGIFY_(x)
// In the binary as plain text, so the server reads a published image's version from the image
// itself (backend/src/firmwareStore.ts). Printed at boot, which also keeps it from being dropped.
static const char VERSION_MARKER[] PROGMEM = "TA-FIRMWARE-VERSION=" STRINGIFY(FIRMWARE_VERSION);

static const unsigned long FIRST_CHECK_MS = 30 * 1000UL;
static const unsigned long CHECK_INTERVAL_MS = 60 * 60 * 1000UL;
// The least time between two checks the server asked for, so a build every check refuses (a bad
// signature, no room) costs one try a minute rather than one per Reading.
static const unsigned long OFFERED_GAP_MS = 60 * 1000UL;
static bool checkedOnce = false;
static bool offered = false;
static unsigned long lastCheckAt = 0;
static String lastResult;
// The version the server last said is waiting for this board (X-Firmware-Available), to name it in
// the log; 0 once it says none is.
static long offeredVersion = 0;
// Set once the server's answer to a check starts sending an image: a failure after that is the board
// refusing the image (its signature, its MD5, no room), not the check failing.
static bool imageArrived = false;

// The download is otherwise silent for about a minute (on the bench, nothing between `checking now`
// and the restart), so the log says when it starts and how it ended.
static void imageStarted() {
  imageArrived = true;
  Serial.print(F("update: "));
  if (offeredVersion > FIRMWARE_VERSION) {
    Serial.print('v');
    Serial.print(offeredVersion);
    Serial.println(F(" offered, downloading"));
  } else {
    Serial.println(F("a newer build offered, downloading"));
  }
}

static void imageInstalled() {
  Serial.println(F("update: installed, restarting"));
  Serial.flush();  // the restart comes straight after
}

void updaterBegin() {
  Serial.print(F("firmware: "));
  Serial.println(FPSTR(VERSION_MARKER));
  Serial.println(ARDUINO_SIGNING ? F("update: on, signed builds only, hourly")
                                 : F("update: off, this build is not signed (no public.key in the sketch folder)"));
  ESPhttpUpdate.setAuthorization("device", DEVICE_TOKEN);  // Basic device:<token>, all the library can send
  ESPhttpUpdate.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);  // the token goes only to SERVER_URL
  ESPhttpUpdate.rebootOnUpdate(true);
  ESPhttpUpdate.onStart(imageStarted);
  ESPhttpUpdate.onEnd(imageInstalled);
}

static void check() {
  const String url = serverUrl("/api/firmware");
  const String version = String(FIRMWARE_VERSION);
  imageArrived = false;
  t_httpUpdate_return result = HTTP_UPDATE_NO_UPDATES;
  const __FlashStringHelper* problem =
      serverRequest([&](WiFiClient& client) { result = ESPhttpUpdate.update(client, url, version); });
  if (problem != nullptr) {
    Serial.print(F("update: skipped, "));
    Serial.println(problem);
    lastResult = String(F("skipped, ")) + problem;
    return;
  }
  // HTTP_UPDATE_OK restarts the board inside update(), so it is never seen here.
  if (result == HTTP_UPDATE_NO_UPDATES) {
    // Named as the server knows this board, so a bench log shows which Device a release must name.
    Serial.print(F("update: none newer for "));
    Serial.print(deviceHostname());
    Serial.print(F(" (running "));
    Serial.print(FIRMWARE_VERSION);
    Serial.println(')');
    lastResult = F("none newer");
  } else if (result == HTTP_UPDATE_FAILED) {
    const int error = ESPhttpUpdate.getLastError();
    const bool refused = imageArrived || error == HTTP_UE_TOO_LESS_SPACE;
    Serial.print(refused ? F("update: refused, ") : F("update: failed, "));
    Serial.print(ESPhttpUpdate.getLastErrorString());
    // The server answers 404 to a board no Device is registered for.
    if (error == HTTP_UE_SERVER_FILE_NOT_FOUND) {
      Serial.print(F(", is "));
      Serial.print(deviceHostname());
      Serial.print(F(" registered?"));
    }
    Serial.println();
    // `failed, ...` either way: the server holds a staged release on it (backend/src/rollout.ts).
    lastResult = String(F("failed, ")) + ESPhttpUpdate.getLastErrorString();
  }
}

void updaterOffered(long version) {
  offeredVersion = version;
  if (!ARDUINO_SIGNING || version <= FIRMWARE_VERSION) return;
  if (!offered) {
    Serial.print(F("update: version "));
    Serial.print(version);
    Serial.println(F(" is waiting, checking now"));
  }
  offered = true;
}

const String& updaterLastResult() {
  return lastResult;
}

void updaterLoop() {
  if (!ARDUINO_SIGNING) return;
  const unsigned long wait = offered ? OFFERED_GAP_MS : checkedOnce ? CHECK_INTERVAL_MS : FIRST_CHECK_MS;
  // Unsigned elapsed time, right across millis() wrapping, as the report interval is.
  if (millis() - lastCheckAt < wait) return;
  checkedOnce = true;
  offered = false;
  lastCheckAt = millis();
  check();
}
