import { useState } from 'react';
import { editDevice, type DeviceEdit } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useChange } from '@/hooks/use-change';
import { CLOSET_MAX } from '@/lib/closet';
import type { Campus, Device } from '@/types';
import { FieldHint, InlineError, InlineForm } from './section';

interface EditDeviceFormProps {
  device: Device;
  campuses: Campus[];
  /** True for an Admin, the only one who can save it. */
  canEdit: boolean;
  /** Saved: the Device as it now is, which is the same Device when nothing was changed. */
  onSaved: (updated: Device) => Promise<void>;
  onCancel: () => void;
  onUnauthorised: () => void;
}

/**
 * The inline editor a Device row turns into. The hostname is shown but cannot be changed,
 * because it is how the board identifies itself; only the Closet and the Campus can.
 * Sends just the fields that differ; saving an untouched form makes no request.
 */
export function EditDeviceForm({ device, campuses, canEdit, onSaved, onCancel, onUnauthorised }: EditDeviceFormProps) {
  const save = useChange(onUnauthorised);
  const [closet, setCloset] = useState(device.closet);
  const [campusId, setCampusId] = useState(String(device.campus.id));
  const [submitted, setSubmitted] = useState(false);

  const closetMissing = closet.trim() === '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (closetMissing) return;
    const changes: DeviceEdit = {};
    if (closet.trim() !== device.closet) changes.closet = closet.trim();
    if (Number(campusId) !== device.campus.id) changes.campusId = Number(campusId);
    if (changes.closet === undefined && changes.campusId === undefined) {
      await onSaved(device);
      return;
    }
    let updated: Device | undefined;
    const result = await save.run(async () => {
      updated = await editDevice(device.id, changes);
    });
    if (result.ok && updated !== undefined) await onSaved(updated);
  };

  return (
    <InlineForm onSubmit={submit} aria-label={`Edit ${device.hostname}`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="edit-device-hostname">Hostname</Label>
          <Input
            id="edit-device-hostname"
            value={device.hostname}
            readOnly
            aria-describedby="edit-device-hostname-hint"
            className="font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-device-campus">Campus</Label>
          <Select value={campusId} onValueChange={setCampusId}>
            <SelectTrigger id="edit-device-campus" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campuses.map((campus) => (
                <SelectItem key={campus.id} value={String(campus.id)}>
                  {campus.name} <span className="text-muted-foreground">({campus.shortcode})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="edit-device-closet">Closet</Label>
          <Input
            id="edit-device-closet"
            value={closet}
            onChange={(event) => setCloset(event.target.value)}
            placeholder="IDF 2"
            maxLength={CLOSET_MAX}
            aria-invalid={(submitted && closetMissing) || undefined}
            aria-describedby={submitted && closetMissing ? 'edit-device-closet-error' : undefined}
            autoFocus
          />
          {submitted && closetMissing && <InlineError id="edit-device-closet-error" message="Name the closet." />}
        </div>
      </div>
      <FieldHint id="edit-device-hostname-hint">
        The hostname cannot be changed. A replaced board is a new Device; its Readings stay with the old one.
      </FieldHint>
      <InlineError message={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.pending || !canEdit}>
          {save.pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={save.pending}>
          Cancel
        </Button>
      </div>
    </InlineForm>
  );
}
