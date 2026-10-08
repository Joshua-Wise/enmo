#include "server.h"

#include <ESP8266HTTPClient.h>

#include "config.h"
#include "roots.h"

// The fallback server is optional: a config.h from before firmware 10 names none, and an empty
// SERVER_URL_2 is none too.
#ifndef SERVER_URL_2
#define SERVER_URL_2 ""
#endif

// sizeof a string literal counts its NUL, so an empty SERVER_URL_2 is 1: no fallback server.
static const uint8_t SERVER_COUNT = sizeof(SERVER_URL_2) > 1 ? 2 : 1;
// Failed reports in a row before moving to the other server: one miss is not an outage.
static const uint8_t FAILURES_TO_MOVE = 2;
// How long the board stays on the fallback server before trying SERVER_URL again.
static const unsigned long RETRY_FIRST_MS = 60 * 60 * 1000UL;

// SERVER_URL and SERVER_URL_2 without a trailing slash, read once, and which is in use.
static String baseUrls[2];
static uint8_t current = 0;
static uint8_t failures = 0;
static unsigned long movedAt = 0;

// Over https:// the server's certificate must chain to a Let's Encrypt root and name SERVER_URL's
// host, as a browser checks it (docs/adr/0001), before the token is sent. Any key or certificate
// the server is given later passes, so no server-side change ever needs a reflash. Parsed once.
static BearSSL::X509List trustedRoots;
static size_t rootsLoaded = 0;

// Certificates have validity dates and the board has no clock. It takes the time from the server's
// own `Date` header, so the Devices' network needs no time server: a GET of /api/health, with no
// token, over TLS it does not check (it has no clock to check with yet). A false time could only
// let an expired certificate for SERVER_URL's host pass, and that still needs the key behind it.
// Refreshed twice a day; millis() carries it in between.
static const unsigned long CLOCK_REFRESH_MS = 12 * 60 * 60 * 1000UL;
static time_t clockBase = 0;  // seconds since 1970 at clockTakenAt; 0 until the server first answers
static unsigned long clockTakenAt = 0;

// Days from 1970-01-01 to a civil date (Howard Hinnant's days_from_civil), so no time zone is involved.
static long daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (long)doe - 719468;
}

// An HTTP date, `Tue, 06 Oct 2026 19:16:39 GMT`, as seconds since 1970; 0 if it is not one.
static time_t parseHttpDate(const String& date) {
  static const char MONTHS[] = "JanFebMarAprMayJunJulAugSepOctNovDec";
  char month[4] = {0};
  int day, year, hour, minute, second;
  if (sscanf(date.c_str(), "%*3s, %d %3s %d %d:%d:%d", &day, month, &year, &hour, &minute, &second) != 6) return 0;
  const char* found = strstr(MONTHS, month);
  if (found == nullptr || strlen(month) != 3 || (found - MONTHS) % 3 != 0 || year < 2026) return 0;
  const unsigned m = (unsigned)((found - MONTHS) / 3 + 1);
  return (time_t)(daysFromCivil(year, m, (unsigned)day) * 86400L + hour * 3600L + minute * 60L + second);
}

// The time now, from the server's clock; 0 when the server has not answered yet.
static time_t serverTime() {
  if (clockBase == 0 || millis() - clockTakenAt >= CLOCK_REFRESH_MS) {
    BearSSL::WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.setTimeout(SERVER_TIMEOUT_MS);
    const char* wanted[] = {"Date"};
    if (http.begin(client, serverUrl("/api/health"))) {
      http.collectHeaders(wanted, 1);
      if (http.GET() > 0) {
        time_t now = parseHttpDate(http.header("Date"));
        if (now != 0) {
          clockBase = now;
          clockTakenAt = millis();
        }
      }
      http.end();
    }
  }
  return clockBase == 0 ? 0 : clockBase + (time_t)((millis() - clockTakenAt) / 1000);
}

static void printServer() {
  Serial.print(baseUrls[current]);
  if (current == 1) Serial.print(F(" (fallback server)"));
}

void serverBegin() {
  const char* const urls[] = {SERVER_URL, SERVER_URL_2};
  bool anyTls = false;
  for (uint8_t i = 0; i < SERVER_COUNT; i++) {
    baseUrls[i] = urls[i];
    if (baseUrls[i].endsWith("/")) baseUrls[i].remove(baseUrls[i].length() - 1);  // forgive the common typo
    anyTls = anyTls || baseUrls[i].startsWith("https://");
  }
  if (SERVER_COUNT > 1) {
    Serial.print(F("server: fallback "));
    Serial.println(baseUrls[1]);
  }
  if (!anyTls) return;
  // Each PEM is copied out of flash only while it is parsed; the list keeps the decoded roots.
  for (size_t i = 0; i < LETS_ENCRYPT_ROOT_COUNT; i++) {
    String pem = FPSTR(LETS_ENCRYPT_ROOTS[i]);
    if (trustedRoots.append(pem.c_str())) rootsLoaded++;
  }
  Serial.print(F("server: https, "));
  Serial.print(rootsLoaded);
  Serial.println(F(" roots, time from the server"));
}

String serverUrl(const char* path) {
  return baseUrls[current] + path;
}

bool serverUsesTls() {
  return baseUrls[current].startsWith("https://");
}

uint8_t serverNumber() {
  return current + 1;
}

static void moveTo(uint8_t index, const __FlashStringHelper* why) {
  current = index;
  failures = 0;
  movedAt = millis();
  clockBase = 0;  // the time comes from the server in use
  Serial.print(F("server: "));
  Serial.print(why);
  Serial.print(F(", now "));
  printServer();
  Serial.println();
}

void serverReportTaken(bool taken) {
  if (SERVER_COUNT < 2) return;
  if (taken) {
    failures = 0;
    // Unsigned elapsed time, right across millis() wrapping.
    if (current == 1 && millis() - movedAt >= RETRY_FIRST_MS) moveTo(0, F("trying the first server again"));
    return;
  }
  if (++failures >= FAILURES_TO_MOVE) moveTo(current ^ 1, F("reports not taken"));
}

const __FlashStringHelper* serverSecure(BearSSL::WiFiClientSecure& client) {
  // Fail closed: without the roots or the time the certificate cannot be checked, and an unchecked
  // server could be anyone answering for the name.
  if (rootsLoaded == 0) return F("no trusted roots loaded");
  const time_t now = serverTime();
  if (now == 0) return F("no time from the server yet");
  // Only a server whose certificate chains to a root, for SERVER_URL's host, completes the handshake;
  // a spoofed DNS answer or a rogue access point fails there, before a request and its token go out.
  // The default 16 KB receive buffer stays: a smaller one only works when the server negotiates
  // MFLN, which nginx does not, and the heap has room.
  client.setTrustAnchors(&trustedRoots);
  client.setX509Time(now);
  return nullptr;
}
