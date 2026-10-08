import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Upload, WifiOff } from 'lucide-react';
import { describeError, getFirmwareStatus, publishFirmware, widenFirmware, withdrawFirmware } from '@/api';
import { ConditionBadge } from '@/components/ConditionBadge';
import { LiveStatus } from '@/components/LiveStatus';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useChange } from '@/hooks/use-change';
import { usePageVisible } from '@/hooks/use-page-visible';
import { useReadingStream, type StreamStatus } from '@/hooks/use-reading-stream';
import { useResource } from '@/hooks/use-resource';
import { levelLook } from '@/lib/conditions';
import { firmwareSummary, holdSentence, progressDetail, rolloutNote, STEP_TEXT } from '@/lib/firmware';
import { formatHeap, formatSignal, formatUptime } from '@/lib/deviceInfo';
import { formatAge } from '@/lib/reportTiming';
import { liveReloads, type LiveReloads } from '@/lib/reload';
import { cn } from '@/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DeviceProgress, FirmwareRelease, FirmwareStatus } from '@/types';
import { DeleteButton, FieldHint, InlineError, InlineForm, SectionHeader, StatusLine } from './section';

interface FirmwareSectionProps {
  /** True for an Admin: the release and the versions are an Admin's to read. */
  canEdit: boolean;
  onUnauthorised: () => void;
}

const dateOf = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** "11:55 PM" today, else with its date: the times a rollout line gives. */
const timeOf = (iso: string): string => {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : dateOf(iso);
};

/** "11:42:05 PM": when the status was last read, to the second, so each re-read shows. */
const clockOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Whole seconds since `iso`, by this browser's clock, as the tables age a report. */
const secondsSince = (iso: string): number => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));

/** How soon boards take a build offered to them (docs/adr/0007), said after publishing it. */
const TAKES_IT = 'A board that sends Readings takes it at its next one; a silent one within the hour, or when it restarts.';

const parseOnly = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((h) => h.trim().toUpperCase())
    .filter((h) => h !== '');

/**
 * Over-the-air firmware (docs/adr/0007): the build on offer, which Devices run it, and publishing a
 * new one. Boards check every hour and install a signed build whose version is above their own.
 */
export function FirmwareSection({ canEdit, onUnauthorised }: FirmwareSectionProps) {
  return (
    <section className="space-y-4" aria-labelledby="firmware-heading">
      <SectionHeader
        id="firmware-heading"
        title="Firmware"
        description="Builds the boards install over WiFi. A board installs a signed build with a higher version than its own within one Report interval of its publication (an hour for boards before version 3), then restarts."
      />
      {canEdit ? (
        <FirmwareStatusAndPublish onUnauthorised={onUnauthorised} />
      ) : (
        <p className="text-sm text-muted-foreground">Only an Admin sees the published firmware and publishes a new build.</p>
      )}
    </section>
  );
}

/**
 * Keeps the tab current while it is open: reads the status again on each `firmware` event the stream
 * carries, when the stream is back after a drop, and every 30 s whatever the stream does, only while
 * the page is visible (lib/reload.ts, liveReloads). The stream's status is the tab's Live indicator.
 */
function useLiveReloads(reload: () => Promise<void>): StreamStatus {
  const visible = usePageVisible();
  const live = useRef<LiveReloads | null>(null);
  useEffect(() => {
    const reloads = liveReloads(reload, () => document.visibilityState === 'visible');
    live.current = reloads;
    return () => {
      reloads.stop();
      live.current = null;
    };
  }, [reload]);
  useEffect(() => {
    live.current?.visibilityChanged();
  }, [visible]);
  return useReadingStream({ onFirmware: () => live.current?.changed(), onReconnect: () => live.current?.changed() });
}

function FirmwareStatusAndPublish({ onUnauthorised }: { onUnauthorised: () => void }) {
  // A re-read that fails keeps the status last read on screen, with when, and says so beside the
  // indicator, so a server restart blanks nothing; only a first read that fails shows its error alone.
  const lastRead = useRef<FirmwareStatus | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const load = useCallback(async (): Promise<FirmwareStatus> => {
    try {
      const status = await getFirmwareStatus();
      lastRead.current = status;
      setReadAt(Date.now());
      setReadError(null);
      return status;
    } catch (error) {
      if (lastRead.current === null) throw error;
      setReadError(`Could not update the firmware status. ${describeError(error)}`);
      return lastRead.current;
    }
  }, []);
  const { state, reload } = useResource(load);
  const stream = useLiveReloads(reload);
  const publish = useChange(onUnauthorised);
  const withdraw = useChange(onUnauthorised);
  const widen = useChange(onUnauthorised);
  const [file, setFile] = useState<File | null>(null);
  const [only, setOnly] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (file === null) return;
    setStatus(null);
    const targets = parseOnly(only);
    const answer: { release?: FirmwareRelease } = {};
    const result = await publish.run(async () => {
      answer.release = await publishFirmware(file, targets);
    });
    if (!result.ok || answer.release === undefined) return;
    // Who it reached, as the server read the names: ESP-64533B and 64533B are ESP_64533B there.
    setStatus(
      targets.length > 0
        ? `${answer.release.offeredTo}. Release to all opens once they have run it cleanly; it holds by itself if one of them fails it.`
        : `${answer.release.offeredTo}. ${TAKES_IT}`,
    );
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    await reload();
  };

  const removeRelease = async () => {
    const result = await withdraw.run(() => withdrawFirmware());
    if (result.ok) {
      setStatus('Withdrawn. Boards keep what they run.');
      await reload();
    }
    return result;
  };

  const releaseToAll = async () => {
    setStatus(null);
    const answer: { release?: FirmwareRelease } = {};
    const result = await widen.run(async () => {
      answer.release = await widenFirmware();
    });
    if (!result.ok || answer.release === undefined) return;
    setStatus(`Released to all. ${answer.release.offeredTo}. ${TAKES_IT}`);
    await reload();
  };

  const summary = state.status === 'ready' ? firmwareSummary(state.data, dateOf) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LiveStatus status={stream} />
        {readAt !== null && <span className="text-sm text-muted-foreground tabular-nums">Updated {clockOf(readAt)}</span>}
      </div>
      <InlineError message={readError} />
      {state.status === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.status === 'error' && <InlineError message={`Could not load the firmware status. ${state.message}`} />}
      {summary !== null && (
        <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-sm">
          <div className="min-w-0 flex-1 space-y-1">
            <p>
              <span className="font-medium">{summary.release}</span> {summary.progress}
            </p>
            {summary.neverChecked.length > 0 && (
              <p className="text-muted-foreground">
                Never checked for an update (flashed before over-the-air updates, or not online since): {summary.neverChecked.join(', ')}.
              </p>
            )}
          </div>
          {state.status === 'ready' && state.data.release !== null && (
            <DeleteButton
              label="Withdraw the published firmware"
              title="Withdraw the published firmware?"
              description="Boards stop being offered this build. Those that installed it keep it."
              error={withdraw.error}
              onConfirm={removeRelease}
              onDismiss={withdraw.clearError}
            />
          )}
        </div>
      )}

      {state.status === 'ready' && state.data.release !== null && state.data.progress !== null && (
        <div className="space-y-3">
          {state.data.rollout !== null ? (
            <StagedRollout release={state.data.release} rollout={state.data.rollout} pending={widen.pending} error={widen.error} onReleaseToAll={releaseToAll} />
          ) : (
            <h3 id="rollout-heading" className="text-sm font-medium">
              Where each Device is
            </h3>
          )}
          {state.data.progress.devices.length > 0 && <RolloutProgress progress={state.data.progress} />}
        </div>
      )}

      {state.status === 'ready' && state.data.devices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="What each Device last reported about itself">
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Sensor</TableHead>
                <TableHead>WiFi network</TableHead>
                <TableHead>WiFi signal</TableHead>
                <TableHead>Up for</TableHead>
                <TableHead>Free memory</TableHead>
                <TableHead>Last restart</TableHead>
                <TableHead>Last update check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data.devices.map((device) => (
                <TableRow key={device.id}>
                  <TableCell>
                    <span className="font-mono">{device.hostname}</span>
                    <span className="block text-xs text-muted-foreground">
                      {device.campus.name} · {device.closet}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{device.firmwareVersion ?? '—'}</TableCell>
                  <TableCell>{device.info?.sensor ?? '—'}</TableCell>
                  <TableCell>
                    {device.info?.ssid ?? '—'}
                    {/* A note, as on its card: the first network could not be joined. Not a warning (owner decision). */}
                    {device.info?.fallback === true && <span className="block text-xs text-muted-foreground">Fallback network</span>}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatSignal(device.info?.rssi ?? null)}</TableCell>
                  <TableCell className="tabular-nums">{formatUptime(device.info?.uptimeSeconds ?? null)}</TableCell>
                  <TableCell className="tabular-nums">{formatHeap(device.info?.freeHeap ?? null)}</TableCell>
                  <TableCell>{device.info?.resetReason ?? '—'}</TableCell>
                  <TableCell>
                    {device.info?.updateResult ?? '—'}
                    {device.info !== null && (
                      <span className="block text-xs text-muted-foreground">
                        as of {formatAge(secondsSince(device.info.at))}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <InlineForm onSubmit={submit} aria-label="Publish firmware">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="firmware-file">Signed build</Label>
            <Input
              ref={fileInput}
              id="firmware-file"
              type="file"
              accept=".signed"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              aria-describedby="firmware-file-hint"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="firmware-only">Only these Devices (optional)</Label>
            <Input
              id="firmware-only"
              value={only}
              onChange={(event) => setOnly(event.target.value)}
              placeholder="ESP_A1B2C3, ESP_D4E5F6"
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase"
              aria-describedby="firmware-only-hint"
            />
          </div>
        </div>
        <FieldHint id="firmware-file-hint">
          TemperatureAlarms.ino.bin.signed from the build, with FIRMWARE_VERSION raised in version.h. The server refuses an unsigned build or a lower version.
        </FieldHint>
        <p id="firmware-only-hint" className="sr-only">
          Leave empty for every Device. Name one bench board first; Release to all then offers the build to every Device once that board has run it cleanly.
        </p>
        <InlineError message={publish.error} />
        <div>
          <Button type="submit" size="sm" disabled={file === null || publish.pending}>
            <Upload aria-hidden />
            {publish.pending ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      </InlineForm>

      <StatusLine message={status} />
    </>
  );
}

interface StagedRolloutProps {
  release: FirmwareRelease;
  rollout: NonNullable<FirmwareStatus['rollout']>;
  pending: boolean;
  error: string | null;
  onReleaseToAll: () => void;
}

/**
 * A staged release's heading (docs/adr/0007): what "Release to all" waits on, with the button once
 * every named Device has run it cleanly. A held release says why and which Device instead, and
 * offers nothing more. RolloutProgress beneath has a line for each named Device.
 */
function StagedRollout({ release, rollout, pending, error, onReleaseToAll }: StagedRolloutProps) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          <h3 id="rollout-heading" className="font-medium">
            Named Devices first
          </h3>
          {release.hold === null ? (
            <p id="rollout-note" className="max-w-prose text-muted-foreground">
              {rolloutNote(rollout, release.version)}
            </p>
          ) : (
            <p className="flex max-w-prose items-start gap-2 text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {holdSentence(release.hold, dateOf)} No other Device is offered it. Withdraw it, or publish a fixed build with a higher version.
              </span>
            </p>
          )}
        </div>
        {release.hold === null && (
          <Button type="button" variant="outline" size="sm" disabled={!rollout.ready || pending} aria-describedby="rollout-note" onClick={onReleaseToAll}>
            {pending ? 'Releasing…' : 'Release to all'}
          </Button>
        )}
      </div>
      <InlineError message={error} />
    </>
  );
}

/**
 * One line per Device the release is offered to, in the server's order (stuck ones first): where it
 * is on the way, waiting, downloading, running the new version and counting clean Readings, or stuck,
 * and what to expect next. `deploy.sh firmware-status` prints the same lines.
 */
function RolloutProgress({ progress }: { progress: NonNullable<FirmwareStatus['progress']> }) {
  const now = Date.now();
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table aria-labelledby="rollout-heading">
        <TableHeader>
          <TableRow>
            <TableHead>Device</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Where it is</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {progress.devices.map((device) => {
            const detail = progressDetail(device, progress.cleanReportsToWiden, now, timeOf);
            return (
              <TableRow key={device.hostname}>
                <TableCell>
                  <span className="font-mono">{device.hostname}</span>
                  {device.device !== null && (
                    <span className="block text-xs text-muted-foreground">
                      {device.device.campus.name} · {device.device.closet}
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{device.firmwareVersion ?? '—'}</TableCell>
                <TableCell className="whitespace-normal">
                  <Step device={device} />
                  {detail !== null && <span className="mt-0.5 block max-w-prose text-muted-foreground tabular-nums">{detail}</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The step, in words. Offline is the Offline badge, in the warning look it has everywhere; a refused
 * image, or a Device no longer registered, is an error; a Sensor fault the server reports (which a
 * staged release holds on) follows as its badge. Every other step is plain text: it is on its way.
 */
function Step({ device }: { device: DeviceProgress }) {
  const faults = (device.conditions ?? []).filter((c) => c.name !== 'Offline');
  const offline = device.conditions?.find((c) => c.name === 'Offline');
  const error = device.step === 'refused' || device.step === 'unregistered';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {device.step === 'offline' && offline !== undefined ? (
        <Badge className={levelLook(offline.level).badge}>
          <WifiOff aria-hidden />
          {STEP_TEXT.offline}
        </Badge>
      ) : (
        <span className={cn('inline-flex items-start gap-1.5 font-medium', error && 'text-destructive')}>
          {error && <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {STEP_TEXT[device.step]}
        </span>
      )}
      {faults.map((condition) => (
        <ConditionBadge key={condition.name} condition={condition} className="px-2 py-0.5 text-xs" />
      ))}
    </span>
  );
}
