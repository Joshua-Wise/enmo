/** What a Campus needs before it can be inserted: the rules the API applies. */
import { parseAddressList } from './config';

const NAME_MAX = 100;
const SHORTCODE_MAX = 20;

/** Normalised campus input, or the message explaining why the body is not one. */
export function parseCampus(body: unknown): { name: string; shortcode: string } | { error: string } {
  const { name, shortcode } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim() === '') return { error: 'A campus needs a name' };
  if (typeof shortcode !== 'string' || shortcode.trim() === '') return { error: 'A campus needs a shortcode' };
  if (name.trim().length > NAME_MAX) return { error: `The name must be at most ${NAME_MAX} characters` };
  if (shortcode.trim().length > SHORTCODE_MAX) {
    return { error: `The shortcode must be at most ${SHORTCODE_MAX} characters` };
  }
  return { name: name.trim(), shortcode: shortcode.trim().toUpperCase() };
}

/** The widest a Campus's recipient list may be, stored as `a@x, b@y`. */
export const RECIPIENTS_MAX = 1000;

/**
 * A Campus's own recipient list (docs/adr/0008), from a comma-separated string or an array of
 * addresses, each checked by the rule NOTIFY_TO is (config.ts). Missing or empty is no list of its
 * own: the Campus emails NOTIFY_TO.
 */
export function parseRecipients(value: unknown): { notifyTo: string[] } | { error: string } {
  if (value === undefined || value === null) return { notifyTo: [] };
  const raw = Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join(',') : value;
  if (typeof raw !== 'string') return { error: 'The recipients must be addresses, comma-separated' };
  const { addresses, bad } = parseAddressList(raw);
  if (bad.length > 0) return { error: `The recipients must be bare addresses like techs@district.example; not an address: ${bad.map((a) => `"${a}"`).join(', ')}` };
  if (addresses.join(', ').length > RECIPIENTS_MAX) return { error: `The recipients must fit in ${RECIPIENTS_MAX} characters; a distribution list keeps it short` };
  return { notifyTo: addresses };
}
