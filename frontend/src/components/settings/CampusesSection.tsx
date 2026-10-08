import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { addCampus, deleteCampus, ForbiddenError, getCampuses, getCampusRecipients } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AnimatePresence } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useChange } from '@/hooks/use-change';
import { useResource } from '@/hooks/use-resource';
import { recipientsProblem } from '@/lib/recipients';
import type { Campus } from '@/types';
import { EditCampusRecipientsForm } from './EditCampusRecipientsForm';
import { AnimatedRow, DeleteButton, EmptyRow, ErrorRow, FieldHint, InlineError, InlineForm, SectionHeader, SkeletonRows, StatusLine, WrappingCell } from './section';

interface CampusesSectionProps {
  /** True for an Admin; a Viewer sees the list without the controls that change it. */
  canEdit: boolean;
  onUnauthorised: () => void;
}

/** A Campus as this section lists it: with its own recipients when an Admin reads it. */
type CampusRow = Campus & { notifyTo?: string[] };

/**
 * The Campuses with their own recipients (docs/adr/0008), which only an Admin may read. A refusal
 * (an Admin made a Viewer since the page loaded) leaves the list without them.
 */
async function getCampusesWithRecipients(): Promise<CampusRow[]> {
  const [campuses, recipients] = await Promise.all([
    getCampuses(),
    getCampusRecipients().catch((error: unknown) => {
      if (error instanceof ForbiddenError) return null;
      throw error;
    }),
  ]);
  if (recipients === null) return campuses;
  const byId = new Map(recipients.map(({ id, notifyTo }) => [id, notifyTo]));
  return campuses.map((campus) => ({ ...campus, notifyTo: byId.get(campus.id) ?? [] }));
}

const NAME_MAX = 100;
const SHORTCODE_MAX = 20;

/** Who a Campus's email goes to, said once it changed. */
const emailsTo = (name: string, notifyTo: string[]): string =>
  notifyTo.length === 0 ? `${name} emails the default recipients.` : `${name} emails ${notifyTo.join(', ')}.`;

export function CampusesSection({ canEdit, onUnauthorised }: CampusesSectionProps) {
  const { state, reload } = useResource<CampusRow[]>(canEdit ? getCampusesWithRecipients : getCampuses);
  const add = useChange(onUnauthorised);
  const remove = useChange(onUnauthorised);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [shortcode, setShortcode] = useState('');
  const [recipients, setRecipients] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The Campus whose row is the recipients form, if any. */
  const [editing, setEditing] = useState<CampusRow | null>(null);
  /** The Campus whose edit button should take focus once its row is back on screen. */
  const [returnFocusTo, setReturnFocusTo] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<number, HTMLButtonElement>());

  // The edit form replaces the row, so its button is only mounted again after the next render.
  useEffect(() => {
    if (returnFocusTo === null) return;
    editButtons.current.get(returnFocusTo)?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo]);

  // Addresses are shown only to an Admin, the only one the server lets read them.
  const showRecipients = canEdit;
  // A Viewer gets neither the recipients nor the actions column.
  const columns = canEdit ? 4 : 2;

  const nameMissing = name.trim() === '';
  const shortcodeMissing = shortcode.trim() === '';
  const recipientsError = recipientsProblem(recipients);

  const closeForm = () => {
    setFormOpen(false);
    setName('');
    setShortcode('');
    setRecipients('');
    setSubmitted(false);
    add.clearError();
  };

  const openForm = () => {
    setStatus(null);
    setFormOpen(true);
  };

  // A campus is added once in a long while, so the form closes on success and focus goes
  // back to the button it came from, with the outcome said once beside it.
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (nameMissing || shortcodeMissing || recipientsError !== null) return;
    const campusName = name.trim();
    const result = await add.run(() => addCampus(campusName, shortcode.trim(), recipients));
    if (!result.ok) return;
    closeForm();
    setStatus(`${campusName} added.`);
    await reload();
    addButton.current?.focus();
  };

  const startEdit = (campus: CampusRow) => {
    setStatus(null);
    setEditing(campus);
  };

  const finishEdit = (id: number) => {
    setEditing(null);
    setReturnFocusTo(id);
  };

  // Only one form at a time, so there is one primary button on the page (DESIGN.md).
  const saveEdit = async (campus: CampusRow, notifyTo: string[]) => {
    const changed = notifyTo.join(', ') !== (campus.notifyTo ?? []).join(', ');
    setStatus(changed ? emailsTo(campus.name, notifyTo) : `${campus.name} unchanged.`);
    finishEdit(campus.id);
    if (changed) await reload();
  };

  const removeCampus = async (id: number, campusName: string) => {
    const result = await remove.run(() => deleteCampus(id));
    if (result.ok) {
      setStatus(`${campusName} deleted.`);
      await reload();
      // The row that held the trash button is gone; land somewhere sensible rather than on body.
      addButton.current?.focus();
    }
    return result;
  };

  return (
    <section className="space-y-4" aria-labelledby="campuses-heading">
      <SectionHeader
        id="campuses-heading"
        title="Campuses"
        description="Every Device belongs to one Campus. The shortcode is what the dashboard filters by. A Campus may name its own email recipients; without them its email goes to the default ones."
        action={
          canEdit && (
            <Button ref={addButton} size="sm" variant="outline" onClick={openForm} disabled={formOpen || editing !== null}>
              <Plus aria-hidden />
              Add campus
            </Button>
          )
        }
      />

      {formOpen && (
        <InlineForm onSubmit={submit} aria-label="Add a campus">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <div className="space-y-2">
              <Label htmlFor="campus-name">Name</Label>
              <Input
                id="campus-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Central High School"
                maxLength={NAME_MAX}
                autoFocus
                aria-invalid={(submitted && nameMissing) || undefined}
                aria-describedby={submitted && nameMissing ? 'campus-name-error' : undefined}
              />
              {submitted && nameMissing && <InlineError id="campus-name-error" message="Give the campus a name." />}
            </div>
            <div className="space-y-2">
              <Label htmlFor="campus-shortcode">Shortcode</Label>
              <Input
                id="campus-shortcode"
                value={shortcode}
                onChange={(event) => setShortcode(event.target.value.toUpperCase())}
                placeholder="CHS"
                maxLength={SHORTCODE_MAX}
                className="uppercase"
                aria-invalid={(submitted && shortcodeMissing) || undefined}
                aria-describedby={submitted && shortcodeMissing ? 'campus-shortcode-error campus-shortcode-hint' : 'campus-shortcode-hint'}
              />
              {submitted && shortcodeMissing && <InlineError id="campus-shortcode-error" message="Give the campus a shortcode." />}
            </div>
          </div>
          <FieldHint id="campus-shortcode-hint">Shortcodes are stored in upper case and must be unique.</FieldHint>
          <div className="space-y-2">
            <Label htmlFor="campus-recipients">Recipients (optional)</Label>
            <Input
              id="campus-recipients"
              type="text"
              inputMode="email"
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
              placeholder="Default recipients"
              aria-invalid={(submitted && recipientsError !== null) || undefined}
              aria-describedby={submitted && recipientsError !== null ? 'campus-recipients-error campus-recipients-hint' : 'campus-recipients-hint'}
            />
            {submitted && recipientsError !== null && <InlineError id="campus-recipients-error" message={recipientsError} />}
          </div>
          <FieldHint id="campus-recipients-hint">
            Comma-separated addresses that get this Campus's email, a distribution list ideally. Empty sends it to the default recipients (NOTIFY_TO in the server's .env).
          </FieldHint>
          <InlineError message={add.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={add.pending || !canEdit}>
              {add.pending ? 'Saving…' : 'Save campus'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={add.pending}>
              Cancel
            </Button>
          </div>
        </InlineForm>
      )}

      <StatusLine message={status} />

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-32">Shortcode</TableHead>
              {showRecipients && <TableHead>Recipients</TableHead>}
              {canEdit && (
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.status === 'loading' && <SkeletonRows columns={columns} />}
            {state.status === 'error' && <ErrorRow colSpan={columns} message={`Could not load campuses. ${state.message}`} onRetry={reload} />}
            {state.status === 'ready' && state.data.length === 0 && (
              <EmptyRow
                colSpan={columns}
                title="No campuses yet"
                hint="Add the first campus, then Devices can be assigned to it."
              />
            )}
            <AnimatePresence initial={false}>
              {state.status === 'ready' &&
                state.data.map((campus) =>
                  editing?.id === campus.id ? (
                  <AnimatedRow key={campus.id} className="hover:bg-transparent">
                    <TableCell colSpan={columns} className="whitespace-normal p-2">
                      <EditCampusRecipientsForm
                        campus={editing}
                        notifyTo={editing.notifyTo ?? []}
                        canEdit={canEdit}
                        onSaved={(notifyTo) => saveEdit(editing, notifyTo)}
                        onCancel={() => finishEdit(campus.id)}
                        onUnauthorised={onUnauthorised}
                      />
                    </TableCell>
                  </AnimatedRow>
                ) : (
                  <AnimatedRow key={campus.id}>
                  <WrappingCell className="font-medium">{campus.name}</WrappingCell>
                  <TableCell className="text-muted-foreground">{campus.shortcode}</TableCell>
                  {showRecipients && (
                    <WrappingCell>
                      {campus.notifyTo === undefined ? null : campus.notifyTo.length === 0 ? (
                        <span className="text-muted-foreground">Default recipients</span>
                      ) : (
                        campus.notifyTo.join(', ')
                      )}
                    </WrappingCell>
                  )}
                  {canEdit && (
                  <TableCell className="whitespace-nowrap text-right">
                    {showRecipients && campus.notifyTo !== undefined && (
                      <Button
                        ref={(element) => {
                          if (element) editButtons.current.set(campus.id, element);
                          else editButtons.current.delete(campus.id);
                        }}
                        variant="ghost"
                        size="icon-sm"
                        disabled={editing !== null || formOpen}
                        aria-label={`Edit the recipients for ${campus.name}`}
                        title={`Edit the recipients for ${campus.name}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => startEdit(campus)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                    )}
                    <DeleteButton
                      label={`Delete ${campus.name}`}
                      title={`Delete ${campus.name}?`}
                      description={`The ${campus.shortcode} filter disappears from the dashboard. A campus that still has Devices cannot be deleted.`}
                      error={remove.error}
                      onConfirm={() => removeCampus(campus.id, campus.name)}
                      onDismiss={remove.clearError}
                    />
                  </TableCell>
                  )}
                  </AnimatedRow>
                ),
              )}
            </AnimatePresence>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
