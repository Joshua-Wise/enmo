// Copy this file to config.h in the same folder and fill in every value.
// config.h is gitignored, so the secrets never reach the repo.
#pragma once

// The WiFi network the Device joins. Leave the password empty ("") for an open
// network, such as one that admits Devices by MAC allowlist.
#define WIFI_SSID "your-network"
#define WIFI_PASSWORD "your-password"

// A second network to fall back to, or "" for none. A board that cannot join the first tries this
// one, the two in turn, 30 seconds each, until one joins, and stays on whichever joined until it
// drops. The password works as the first's: empty for an open network. Both must reach SERVER_URL.
// A board on this one says so with every report: a note on its Dashboard card, never a Condition
// or an email. To move boards to a new network over the air, name the new one here, then publish a
// later build that names it first (README, "The fallback network").
#define WIFI_SSID_2 ""
#define WIFI_PASSWORD_2 ""

// Where the backend is served, without a trailing slash. Readings are posted to
// SERVER_URL/api/readings, and the board checks /api/firmware for updates. Production boards:
// https://YOUR_DOMAIN, the name the dashboard is served at. Its certificate must chain to a Let's
// Encrypt root (roots.cpp) and name that host, so renewals and key changes on the server never
// need a reflash; the board takes the time from the server itself. Run the README's "Transport
// for production boards" checks before flashing. On a desk, the Compose stack is http://<host>
// (add :PORT only if WEB_PORT was changed).
#define SERVER_URL "https://YOUR_DOMAIN"

// A second server to fall back to, or "" for none. A board whose reports SERVER_URL does not take
// twice in a row (no answer, the token refused, the Device not registered there, a server error)
// moves to this one, and after an hour there tries SERVER_URL again. Both take the same Device token
// and need the Device registered; the board updates over the air from whichever it is on.
#define SERVER_URL_2 ""

// Must match DEVICE_TOKEN in the backend .env (docs/adr/0003).
#define DEVICE_TOKEN "change-me-device"

// The sensor on the board: DHT11 (the original, to within 2 C and 5 % humidity), DHT22 (0.5 C, 2 %)
// or SHT31 (I2C, 0.3 C, 2 %). One per build: a batch of each kind is its own export. The README's
// Hardware section has the wiring for each; only the pins of the sensor named here are used.
#define SENSOR_TYPE DHT11

// DHT11 and DHT22: the GPIO the DATA pin is on. 5 is D1, where dht11-pinout.svg wires a separate
// sensor (a DHT22 wires the same way). A NodeMCU with the DHT11 soldered on (the "ESP8266 + DHT11"
// boards) has it on GPIO 4, D2.
#define DHT_PIN 5

// SHT31: the GPIOs of the I2C bus, 4 (D2) for SDA and 5 (D1) for SCL as wired in the README, and the
// sensor's address: 0x44, or 0x45 on a breakout whose ADDR pin is tied to 3V3.
#define SHT31_SDA_PIN 4
#define SHT31_SCL_PIN 5
#define SHT31_ADDRESS 0x44

// How often a Reading is sent. Must match REPORT_INTERVAL_SECONDS in the backend
// .env, which is 30 unless changed there. The DHT sensors cannot sample faster than every 2 s.
#define REPORT_INTERVAL_SECONDS 30
