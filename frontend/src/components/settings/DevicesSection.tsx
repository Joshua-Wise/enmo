import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { addDevice, deleteDevice, getCampuses, getDevices } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AnimatePresence } from 'framer-motion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useChange } from '@/hooks/use-change';
import { useResource } from '@/hooks/use-resource';
import { CLOSET_MAX } from '@/lib/closet';
import { HOSTNAME_EXAMPLE, hostnameProblem } from '@/lib/hostname';
import type { Device } from '@/types';
import { EditDeviceForm } from './EditDeviceForm';
import { AnimatedRow, DeleteButton, EmptyRow, ErrorRow, FieldHint, InlineError, InlineForm, SectionHeader, SkeletonRows, StatusLine, WrappingCell } from './section';

interface DevicesSectionProps {
  /** True for an Admin; a Viewer sees the list without the controls that change it. */
  canEdit: boolean;
  onUnauthorised: () => void;
}

const COLUMNS = 4;
const HOSTNAME_LENGTH = HOSTNAME_EXAMPLE.length;
const EMPTY_FORM = { hostname: '', campusId: '', closet: '' };

export function DevicesSection({ canEdit, onUnauthorised }: DevicesSectionProps) {
  const { state, reload } = useResource(getDevices);
  const campuses = useResource(getCampuses);
  const add = useChange(onUnauthorised);
  const remove = useChange(onUnauthorised);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [hostnameTouched, setHostnameTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The Device whose row is the edit form, if any. */
  const [editing, setEditing] = useState<Device | null>(null);
  /** The Device whose edit button should take focus once its row is back on screen. */
  const [returnFocusTo, setReturnFocusTo] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const hostnameInput = useRef<HTMLInputElement>(null);
  const editButtons = useRef(new Map<number, HTMLButtonElement>());

  // The edit form replaces the row, so its button is only mounted again after the next render.
  useEffect(() => {
    if (returnFocusTo === null) return;
    editButtons.current.get(returnFocusTo)?.focus();
    setReturnFocusTo(null);
  }, [returnFocusTo]);

  const hostnameError = form.hostname === '' ? (submitted ? 'Enter the hostname.' : null) : hostnameProblem(form.hostname);
  const showHostnameError = (hostnameTouched || submitted) && hostnameError !== null;
  const campusMissing = form.campusId === '';
  const closetMissing = form.closet.trim() === '';

  const closeForm = () => {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setHostnameTouched(false);
    setSubmitted(false);
    add.clearError();
  };

  const openForm = () => {
    setStatus(null);
    setFormOpen(true);
  };

  // Boards are flashed in batches, so a saved Device leaves the form open for the next one:
  // hostname and closet cleared, the campus kept, focus back in the hostname field.
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setHostnameTouched(true);
    if (hostnameError !== null || campusMissing || closetMissing) return;
    const hostname = form.hostname;
    const result = await add.run(() => addDevice(hostname, Number(form.campusId), form.closet.trim()));
    if (!result.ok) return;
    setForm({ ...EMPTY_FORM, campusId: form.campusId });
    setHostnameTouched(false);
    setSubmitted(false);
    setStatus(`${hostname} added. It appears on the dashboard with its first Reading.`);
    await reload();
    hostnameInput.current?.focus();
  };

  const startEdit = (device: Device) => {
    setStatus(null);
    setEditing(device);
  };

  const finishEdit = (id: number) => {
    setEditing(null);
    setReturnFocusTo(id);
  };

  const describeEdit = (before: Device, after: Device) => {
    const closetChanged = after.closet !== before.closet;
    const campusChanged = after.campus.id !== before.campus.id;
    if (closetChanged && campusChanged) return `${after.hostname} is now ${after.closet} at ${after.campus.name}.`;
    if (campusChanged) return `${after.hostname} moved to ${after.campus.name}.`;
    if (closetChanged) return `${after.hostname} is now ${after.closet}.`;
    return null;
  };

  // Only one form at a time, so there is one primary button on the page (DESIGN.md).
  const saveEdit = async (before: Device, after: Device) => {
    const change = describeEdit(before, after);
    setStatus(change ?? `${after.hostname} unchanged.`);
    finishEdit(after.id);
    if (change !== null) await reload();
  };

  const removeDevice = async (id: number, hostname: string) => {
    const result = await remove.run(() => deleteDevice(id));
    if (result.ok) {
      setStatus(`${hostname} deleted.`);
      await reload();
      // The row that held the trash button is gone; land somewhere sensible rather than on body.
      addButton.current?.focus();
    }
    return result;
  };

  const campusOptions = campuses.state.status === 'ready' ? campuses.state.data : [];
  const noCampuses = campuses.state.status === 'ready' && campusOptions.length === 0;
  // A Viewer gets no actions column.
  const columns = canEdit ? COLUMNS : COLUMNS - 1;

  return (
    <section className="space-y-4" aria-labelledby="devices-heading">
      <SectionHeader
        id="devices-heading"
        title="Devices"
        description="One Device per Closet, identified by its ESP_ hostname. Deleting a Device deletes its Readings."
        action={
          canEdit && (
            <Button ref={addButton} size="sm" variant="outline" onClick={openForm} disabled={formOpen || editing !== null}>
              <Plus aria-hidden />
              Add device
            </Button>
          )
        }
      />

      {formOpen && (
        <InlineForm onSubmit={submit} aria-label="Add a device">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="device-hostname">Hostname</Label>
              <Input
                ref={hostnameInput}
                id="device-hostname"
                value={form.hostname}
                onChange={(event) => setForm({ ...form, hostname: event.target.value.toUpperCase().trim() })}
                onBlur={() => setHostnameTouched(true)}
                placeholder={HOSTNAME_EXAMPLE}
                maxLength={HOSTNAME_LENGTH}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
                aria-invalid={showHostnameError || undefined}
                aria-describedby={showHostnameError ? 'device-hostname-error device-hostname-hint' : 'device-hostname-hint'}
                autoFocus
              />
              {showHostnameError && <InlineError id="device-hostname-error" message={hostnameError} />}
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-campus">Campus</Label>
              <Select value={form.campusId} onValueChange={(campusId) => setForm({ ...form, campusId })} disabled={noCampuses}>
                <SelectTrigger
                  id="device-campus"
                  className="w-full"
                  aria-invalid={(submitted && campusMissing && !noCampuses) || undefined}
                  aria-describedby={submitted && campusMissing && !noCampuses ? 'device-campus-error' : undefined}
                >
                  <SelectValue placeholder={noCampuses ? 'No campuses yet' : 'Choose a campus'} />
                </SelectTrigger>
                <SelectContent>
                  {campusOptions.map((campus) => (
                    <SelectItem key={campus.id} value={String(campus.id)}>
                      {campus.name} <span className="text-muted-foreground">({campus.shortcode})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {submitted && campusMissing && !noCampuses && <InlineError id="device-campus-error" message="Choose the campus the closet is at." />}
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-closet">Closet</Label>
              <Input
                id="device-closet"
                value={form.closet}
                onChange={(event) => setForm({ ...form, closet: event.target.value })}
                placeholder="IDF 2"
                maxLength={CLOSET_MAX}
                aria-invalid={(submitted && closetMissing) || undefined}
                aria-describedby={submitted && closetMissing ? 'device-closet-error device-closet-hint' : 'device-closet-hint'}
              />
              {submitted && closetMissing && <InlineError id="device-closet-error" message="Name the closet." />}
            </div>
          </div>
          <FieldHint id="device-hostname-hint">
            The hostname is ESP_ followed by the last six hex digits of the Device's MAC address. It is printed to serial on boot.
          </FieldHint>
          <p id="device-closet-hint" className="sr-only">
            Name the closet by its network role and number, like IDF 2 or MDF.
          </p>
          {noCampuses && <InlineError message="A Device needs a Campus. Add one on the Campuses tab first." />}
          <InlineError message={add.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={add.pending || !canEdit || noCampuses}>
              {add.pending ? 'Saving…' : 'Save device'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={add.pending}>
              {status === null ? 'Cancel' : 'Done'}
            </Button>
            {noCampuses && (
              <Button asChild type="button" size="sm" variant="link">
                <Link to="/settings?tab=campuses">Go to Campuses</Link>
              </Button>
            )}
          </div>
        </InlineForm>
      )}

      <StatusLine message={status} />

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hostname</TableHead>
              <TableHead>Campus</TableHead>
              <TableHead>Closet</TableHead>
              {canEdit && (
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.status === 'loading' && <SkeletonRows columns={columns} />}
            {state.status === 'error' && <ErrorRow colSpan={columns} message={`Could not load devices. ${state.message}`} onRetry={reload} />}
            {state.status === 'ready' && state.data.length === 0 && (
              <EmptyRow colSpan={columns} title="No devices yet" hint="Add a Device by its hostname to see it on the dashboard." />
            )}
            <AnimatePresence initial={false}>
              {state.status === 'ready' &&
                state.data.map((device) =>
                  editing?.id === device.id ? (
                  <AnimatedRow key={device.id} className="hover:bg-transparent">
                    <TableCell colSpan={columns} className="whitespace-normal p-2">
                      <EditDeviceForm
                        device={editing}
                        campuses={campusOptions}
                        canEdit={canEdit}
                        onSaved={(updated) => saveEdit(editing, updated)}
                        onCancel={() => finishEdit(device.id)}
                        onUnauthorised={onUnauthorised}
                      />
                    </TableCell>
                  </AnimatedRow>
                ) : (
                  <AnimatedRow key={device.id}>
                    <TableCell className="font-mono font-medium">
                      {device.hostname}
                      {device.tokenMismatchAt && (
                        <Badge
                          className="ml-2 border-transparent bg-amber-500/15 font-sans text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"
                          title="Its Readings are refused: the Device token on the board is not the server's"
                        >
                          Token mismatch
                        </Badge>
                      )}
                    </TableCell>
                    <WrappingCell>
                      {device.campus.name} <span className="text-sm text-muted-foreground">{device.campus.shortcode}</span>
                    </WrappingCell>
                    <WrappingCell>{device.closet}</WrappingCell>
                    {canEdit && (
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        ref={(element) => {
                          if (element) editButtons.current.set(device.id, element);
                          else editButtons.current.delete(device.id);
                        }}
                        variant="ghost"
                        size="icon-sm"
                        disabled={editing !== null || formOpen}
                        aria-label={`Edit ${device.hostname}`}
                        title={`Edit ${device.hostname}`}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => startEdit(device)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <DeleteButton
                        label={`Delete ${device.hostname}`}
                        title={`Delete ${device.hostname}?`}
                        description={`Every Reading from ${device.closet} at ${device.campus.name} is deleted with it. Add the Device again to store new Readings.`}
                        error={remove.error}
                        onConfirm={() => removeDevice(device.id, device.hostname)}
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
