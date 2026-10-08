import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { addDevice, forgetPendingDevice, getCampuses, getPendingDevices, setPendingIgnored } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useChange } from '@/hooks/use-change';
import { useResource } from '@/hooks/use-resource';
import { CLOSET_MAX } from '@/lib/closet';
import { formatAge } from '@/lib/reportTiming';
import type { PendingDevice } from '@/types';
import { DeleteButton, EmptyRow, ErrorRow, InlineError, InlineForm, SectionHeader, SkeletonRows, StatusLine } from './section';

interface NewDevicesSectionProps {
  /** True for an Admin: the list itself is an Admin's to read. */
  canEdit: boolean;
  onUnauthorised: () => void;
}

const COLUMNS = 5;
const ageOf = (iso: string): string => formatAge(Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)));

/**
 * Boards that report with the Device token but are not registered: adopt one by giving it a Campus
 * and Closet (it becomes a Device, and its next Reading is recorded), hide it from the pop-up, or
 * forget it until it reports again.
 */
export function NewDevicesSection({ canEdit, onUnauthorised }: NewDevicesSectionProps) {
  return (
    <section className="space-y-4" aria-labelledby="new-devices-heading">
      <SectionHeader
        id="new-devices-heading"
        title="New devices"
        description="Boards reporting with the Device token that are not added yet. Their Readings are refused until you adopt them."
      />
      {canEdit ? (
        <PendingList onUnauthorised={onUnauthorised} />
      ) : (
        <p className="text-sm text-muted-foreground">Only an Admin sees boards waiting to be added.</p>
      )}
    </section>
  );
}

function PendingList({ onUnauthorised }: { onUnauthorised: () => void }) {
  const { state, reload } = useResource(getPendingDevices);
  const campuses = useResource(getCampuses);
  const [searchParams] = useSearchParams();
  const [adopting, setAdopting] = useState<string | null>(searchParams.get('adopt'));
  const [status, setStatus] = useState<string | null>(null);
  const change = useChange(onUnauthorised);
  const forget = useChange(onUnauthorised);

  const toggleIgnored = async (board: PendingDevice) => {
    const result = await change.run(() => setPendingIgnored(board.hostname, !board.ignored));
    if (result.ok) {
      setStatus(board.ignored ? `${board.hostname} will pop up again.` : `${board.hostname} will not pop up again.`);
      await reload();
    }
  };

  const forgetBoard = async (hostname: string) => {
    const result = await forget.run(() => forgetPendingDevice(hostname));
    if (result.ok) {
      setStatus(`${hostname} forgotten. It comes back if it reports again.`);
      await reload();
    }
    return result;
  };

  const adopted = async (hostname: string, campusName: string) => {
    setAdopting(null);
    setStatus(`${hostname} adopted at ${campusName}. Its next Reading appears on the dashboard.`);
    await reload();
  };

  return (
    <>
      <InlineError message={change.error} />
      <StatusLine message={status} />
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hostname</TableHead>
              <TableHead>Last heard</TableHead>
              <TableHead>Last Reading</TableHead>
              <TableHead>Address</TableHead>
              <TableHead className="w-56">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.status === 'loading' && <SkeletonRows columns={COLUMNS} />}
            {state.status === 'error' && <ErrorRow colSpan={COLUMNS} message={`Could not load new devices. ${state.message}`} onRetry={reload} />}
            {state.status === 'ready' && state.data.length === 0 && (
              <EmptyRow colSpan={COLUMNS} title="No new devices" hint="A flashed board that is not added yet shows up here with its first Reading." />
            )}
            {state.status === 'ready' &&
              state.data.map((board) =>
                adopting === board.hostname ? (
                  <TableRow key={board.hostname} className="hover:bg-transparent">
                    <TableCell colSpan={COLUMNS} className="whitespace-normal p-2">
                      <AdoptForm
                        hostname={board.hostname}
                        campuses={campuses.state.status === 'ready' ? campuses.state.data : []}
                        onUnauthorised={onUnauthorised}
                        onAdopted={adopted}
                        onCancel={() => setAdopting(null)}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={board.hostname}>
                    <TableCell className="font-mono">
                      {board.hostname}
                      {board.ignored && (
                        <Badge variant="outline" className="ml-2 font-sans">
                          Ignored
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <time dateTime={board.lastSeen} title={new Date(board.lastSeen).toLocaleString()}>
                        {ageOf(board.lastSeen)}
                      </time>
                      <span className="text-muted-foreground"> · {board.reports} {board.reports === 1 ? 'report' : 'reports'}</span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {board.lastReading === null ? <span className="text-muted-foreground">None yet</span> : `${board.lastReading.tempF} °F, ${board.lastReading.humidity} %`}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{board.address ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => setAdopting(board.hostname)} disabled={adopting !== null}>
                          <Plus aria-hidden />
                          Adopt
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggleIgnored(board)} disabled={change.pending}>
                          {board.ignored ? 'Unignore' : 'Ignore'}
                        </Button>
                        <DeleteButton
                          label={`Forget ${board.hostname}`}
                          title={`Forget ${board.hostname}?`}
                          description="It leaves this list, and comes back if it reports again. Nothing on the board changes."
                          error={forget.error}
                          onConfirm={() => forgetBoard(board.hostname)}
                          onDismiss={forget.clearError}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

interface AdoptFormProps {
  hostname: string;
  campuses: Array<{ id: number; name: string; shortcode: string }>;
  onUnauthorised: () => void;
  onAdopted: (hostname: string, campusName: string) => void;
  onCancel: () => void;
}

function AdoptForm({ hostname, campuses, onUnauthorised, onAdopted, onCancel }: AdoptFormProps) {
  const [campusId, setCampusId] = useState('');
  const [closet, setCloset] = useState('');
  const add = useChange(onUnauthorised);
  const ready = campusId !== '' && closet.trim() !== '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const result = await add.run(() => addDevice(hostname, Number(campusId), closet.trim()));
    if (result.ok) onAdopted(hostname, campuses.find((c) => String(c.id) === campusId)?.name ?? 'its Campus');
  };

  return (
    <InlineForm onSubmit={submit} aria-label={`Adopt ${hostname}`}>
      <p className="text-sm">
        Adopt <span className="font-mono">{hostname}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="adopt-campus">Campus</Label>
          <Select value={campusId} onValueChange={setCampusId} disabled={campuses.length === 0}>
            <SelectTrigger id="adopt-campus" className="w-full">
              <SelectValue placeholder={campuses.length === 0 ? 'No campuses yet' : 'Choose a campus'} />
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
          <Label htmlFor="adopt-closet">Closet</Label>
          <Input id="adopt-closet" value={closet} onChange={(event) => setCloset(event.target.value)} placeholder="IDF 2" maxLength={CLOSET_MAX} autoFocus />
        </div>
      </div>
      {campuses.length === 0 && <InlineError message="A Device needs a Campus. Add one on the Campuses tab first." />}
      <InlineError message={add.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ready || add.pending}>
          {add.pending ? 'Adopting…' : 'Adopt device'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={add.pending}>
          Cancel
        </Button>
      </div>
    </InlineForm>
  );
}
