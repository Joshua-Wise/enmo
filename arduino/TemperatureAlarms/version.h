// The firmware's version: a whole number, raised by one for every build that is published over the
// air (README, "Updating boards over the air"). A board takes a published build only when its version
// is higher than its own, so a build with the same number is never installed twice.
#pragma once

#define FIRMWARE_VERSION 10
