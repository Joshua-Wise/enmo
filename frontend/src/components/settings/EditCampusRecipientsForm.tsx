import { useState } from 'react';
import { setCampusRecipients } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChange } from '@/hooks/use-change';
import { addressesOf, recipientsProblem } from '@/lib/recipients';
import type { Campus } from '@/types';
import { FieldHint, InlineError, InlineForm } from './section';

interface EditCampusRecipientsFormProps {
  campus: Campus;
  /** The Campus's own recipients now; empty when it emails the default ones. */
  notifyTo: string[];
  /** True for an Admin, the only one who can save it. */
  canEdit: boolean;
  /** Saved: the list as it now is, which is the same list when nothing was changed. */
  onSaved: (notifyTo: string[]) => Promise<void>;
  onCancel: () => void;
  onUnauthorised: () => void;
}

/**
 * The inline editor a Campus row turns into: only its own recipients (docs/adr/0008), checked
 * here by the rule the server applies to NOTIFY_TO. Saving an untouched list makes no request.
 */
export function EditCampusRecipientsForm({ campus, notifyTo, canEdit, onSaved, onCancel, onUnauthorised }: EditCampusRecipientsFormProps) {
  const save = useChange(onUnauthorised);
  const [recipients, setRecipients] = useState(notifyTo.join(', '));
  const [submitted, setSubmitted] = useState(false);

  const problem = recipientsProblem(recipients);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (problem !== null) return;
    const next = addressesOf(recipients);
    if (next.join(', ') === notifyTo.join(', ')) {
      await onSaved(notifyTo);
      return;
    }
    let saved: string[] | undefined;
    const result = await save.run(async () => {
      saved = (await setCampusRecipients(campus.id, recipients)).notifyTo;
    });
    if (result.ok && saved !== undefined) await onSaved(saved);
  };

  return (
    <InlineForm onSubmit={submit} aria-label={`Recipients for ${campus.name}`}>
      <div className="space-y-2">
        <Label htmlFor="edit-campus-recipients">Recipients for {campus.name}</Label>
        <Input
          id="edit-campus-recipients"
          type="text"
          inputMode="email"
          value={recipients}
          onChange={(event) => setRecipients(event.target.value)}
          placeholder="Default recipients"
          autoFocus
          aria-invalid={(submitted && problem !== null) || undefined}
          aria-describedby={submitted && problem !== null ? 'edit-campus-recipients-error edit-campus-recipients-hint' : 'edit-campus-recipients-hint'}
        />
        {submitted && problem !== null && <InlineError id="edit-campus-recipients-error" message={problem} />}
      </div>
      <FieldHint id="edit-campus-recipients-hint">
        Comma-separated addresses that get this Campus's email, a distribution list ideally. Empty sends it to the default recipients (NOTIFY_TO in the server's .env).
      </FieldHint>
      <InlineError message={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.pending || !canEdit}>
          {save.pending ? 'Saving…' : 'Save recipients'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={save.pending}>
          Cancel
        </Button>
      </div>
    </InlineForm>
  );
}
