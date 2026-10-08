/** What a Device needs before it can be inserted: the rules the API applies. */

interface DeviceInput {
  hostname: string;
  campusId: number;
  closet: string;
}

/** The fields an edit may change. The hostname is not one: a replaced board is a new Device. */
export interface DeviceEdit {
  campusId?: number;
  closet?: string;
}

/** A Device is named by its ESP8266 hostname: `ESP_` plus the last six hex digits of its MAC. */
const HOSTNAME_PATTERN = /^ESP_[0-9A-F]{6}$/;
const CLOSET_MAX = 50;

/** The largest INT UNSIGNED, the campus id column's range. A larger id cannot name a Campus. */
const CAMPUS_ID_MAX = 4_294_967_295;

function isCampusId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= CAMPUS_ID_MAX;
}

/** The trimmed closet name, or the message explaining why it is not one. */
function parseCloset(closet: unknown): { closet: string } | { error: string } {
  if (typeof closet !== 'string' || closet.trim() === '') return { error: 'A device needs a closet name' };
  if (closet.trim().length > CLOSET_MAX) return { error: `The closet name must be at most ${CLOSET_MAX} characters` };
  return { closet: closet.trim() };
}

/** Normalised device input, or the message explaining why the body is not one. */
export function parseDevice(body: unknown): DeviceInput | { error: string } {
  const { hostname, campusId, closet } = (body ?? {}) as Record<string, unknown>;
  const normalisedHostname = typeof hostname === 'string' ? hostname.trim().toUpperCase() : '';
  if (!HOSTNAME_PATTERN.test(normalisedHostname)) {
    return { error: 'The hostname must be ESP_ followed by six hex digits, like ESP_A1B2C3' };
  }
  if (!isCampusId(campusId)) return { error: 'A device needs a campus' };
  const parsedCloset = parseCloset(closet);
  if ('error' in parsedCloset) return parsedCloset;
  return { hostname: normalisedHostname, campusId, closet: parsedCloset.closet };
}

/**
 * The changes an edit asks for, validated as an add is, or the message explaining why they
 * cannot be applied. Only the fields present are checked; at least one must be.
 */
export function parseDeviceEdit(body: unknown): DeviceEdit | { error: string } {
  const { hostname, campusId, closet } = (body ?? {}) as Record<string, unknown>;
  if (hostname !== undefined) {
    return { error: 'The hostname cannot be changed: a replaced board is a new Device' };
  }
  const edit: DeviceEdit = {};
  if (campusId !== undefined) {
    if (!isCampusId(campusId)) return { error: 'A device needs a campus' };
    edit.campusId = campusId;
  }
  if (closet !== undefined) {
    const parsedCloset = parseCloset(closet);
    if ('error' in parsedCloset) return parsedCloset;
    edit.closet = parsedCloset.closet;
  }
  if (edit.campusId === undefined && edit.closet === undefined) {
    return { error: 'Give a closet name or a campus to change' };
  }
  return edit;
}
