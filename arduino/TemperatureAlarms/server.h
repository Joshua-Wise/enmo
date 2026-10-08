// Server: where SERVER_URL points (or SERVER_URL_2, the fallback server, while the first is not taking
// reports), and a TLS client that trusts only a real certificate for it. Shared by the reporter
// (Readings) and the updater (firmware), so both send the Device token only to the same, checked server.
#pragma once

#include <Arduino.h>
#include <WiFiClientSecure.h>

// How long any request to the server may wait for an answer.
static const unsigned long SERVER_TIMEOUT_MS = 10 * 1000UL;

// Reads SERVER_URL and SERVER_URL_2 once; over https:// also loads Let's Encrypt's roots (roots.cpp).
void serverBegin();

// The server in use without a trailing slash, followed by `path` (which starts with '/').
String serverUrl(const char* path);

// True when the server in use is https://.
bool serverUsesTls();

// Which server is in use: 1 for SERVER_URL, 2 for SERVER_URL_2.
uint8_t serverNumber();

// How a report went, so the board can move to the other server. `taken` false (no answer, no checked
// TLS, the token refused, the Device unknown there, a server error) twice in a row moves to the other
// server, when config.h names two. On the fallback server, after an hour of taken reports the board
// tries SERVER_URL again, and comes back if that fails twice.
void serverReportTaken(bool taken);

// Sets `client` to accept only a certificate that chains to a Let's Encrypt root and names
// SERVER_URL's host, at the current time. Returns nullptr when ready, otherwise why not (no roots,
// or no time from the server yet), in which case nothing may be sent.
const __FlashStringHelper* serverSecure(BearSSL::WiFiClientSecure& client);

// Calls `request(client)` with a client for SERVER_URL: one checked by serverSecure() over https://,
// a plain one otherwise. Returns nullptr once it has run, or serverSecure()'s reason when it could not
// run, in which case nothing (no token) was sent.
template <typename Request>
const __FlashStringHelper* serverRequest(Request request) {
  if (!serverUsesTls()) {
    WiFiClient client;
    request(client);
    return nullptr;
  }
  BearSSL::WiFiClientSecure client;
  const __FlashStringHelper* problem = serverSecure(client);
  if (problem == nullptr) request(client);
  return problem;
}
