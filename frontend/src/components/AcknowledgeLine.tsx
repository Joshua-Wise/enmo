import { useId, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { acknowledgeIncident, describeError } from '@/api';
import { InlineError } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useIsAdmin } from '@/hooks/use-session';
import { ACKNOWLEDGED_BY_MAX, acknowledgedAgo, acknowledgerError, rememberName, rememberedName } from '@/lib/acknowledgement';
import { formatTime } from '@/lib/localDate';
import type { Acknowledgement, ConditionName, Incident } from '@/types';

interface AcknowledgeLineProps {
  /** The incident as the card or the row holds it. */
  incident: { id: number; condition: ConditionName; acknowledgement: Acknowledgement | null };
  /** False once it has ended: an ended incident cannot be acknowledged, though who did stays. */
  open: boolean;
  /** Say which Condition the line is about: the card holds more than one open incident. */
  named: boolean;
  /** Where the incident is, for the button's accessible name ("IDF 2, Central High School"). */
  place: string;
  /** "10 min ago" on a card, read at a glance; "at 2:10 AM" in the log, which reads in times. */
  when: 'age' | 'time';
  /** With the time, a day name before it ("Tue, "), when the row's other times carry one too; '' otherwise. */
  day?: string;
  /** Now, by this browser's clock, for the age. */
  now: number;
  /** The server's answer, so the line changes before the stream's message arrives. */
  onAcknowledged: (incident: Incident) => void;
}

/**
 * Who is on an incident (CONTEXT.md, Acknowledgement): "Acknowledged by Sam, 10 min ago" in grey,
 * the name in Readout White, since being on it is not a level and takes no signal colour. Until
 * someone is, an Admin sees a ghost "Acknowledge" that opens a small field for a name or a short
 * note; a Viewer sees nothing.
 */
export function AcknowledgeLine({ incident, open, named, place, when, day = '', now, onAcknowledged }: AcknowledgeLineProps) {
  const admin = useIsAdmin();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldId = useId();
  const prefix = named ? `${incident.condition}: ` : '';

  const { acknowledgement } = incident;
  if (acknowledgement !== null) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground tabular-nums">
        <UserCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          {prefix}
          {named ? 'acknowledged' : 'Acknowledged'} by <b className="font-medium text-foreground">{acknowledgement.by}</b>
          {when === 'age' ? ', ' : ' at '}
          <time dateTime={acknowledgement.at} title={new Date(acknowledgement.at).toLocaleString()}>
            {when === 'age' ? acknowledgedAgo(acknowledgement, now) : `${day}${formatTime(acknowledgement.at)}`}
          </time>
        </span>
      </p>
    );
  }

  // Shown while the form is open even if the server just refused it, so the message stays to read.
  if (!open || (!admin && !editing)) return null;

  if (!editing) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2.5 w-fit text-muted-foreground"
        aria-label={`Acknowledge ${incident.condition}, ${place}`}
        onClick={() => {
          setName(rememberedName());
          setError(null);
          setEditing(true);
        }}
      >
        <UserCheck aria-hidden />
        {named ? `Acknowledge ${incident.condition}` : 'Acknowledge'}
      </Button>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const invalid = acknowledgerError(name);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const answer = await acknowledgeIncident(incident.id, name.trim());
      rememberName(name.trim());
      setEditing(false);
      onAcknowledged(answer);
    } catch (thrown) {
      setError(describeError(thrown));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-2" aria-label={`Acknowledge ${incident.condition}, ${place}`}>
      <Label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">
        {prefix}Who is on it? A name, or a short note
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={fieldId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sam"
          maxLength={ACKNOWLEDGED_BY_MAX}
          autoComplete="name"
          aria-invalid={error !== null || undefined}
          className="h-8 min-w-0 flex-1 basis-40"
          autoFocus
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Acknowledge'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
      <InlineError message={error} />
    </form>
  );
}
