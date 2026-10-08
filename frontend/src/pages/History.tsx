import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { usePageTitle } from '@/hooks/use-page-title';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import NumberFlow from '@number-flow/react';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, Download, Info, Trash2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceDot, XAxis, YAxis } from 'recharts';
import { getHistory, incidentsCsvUrl, readingsCsvUrl, resetHistory } from '@/api';
import { LiveStatus } from '@/components/LiveStatus';
import { Placeholder } from '@/components/Placeholder';
import { NoValue, Tile } from '@/components/Tile';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIsAdmin } from '@/hooks/use-session';
import { useChange } from '@/hooks/use-change';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useReadingStream } from '@/hooks/use-reading-stream';
import { cardScope, headingScope, morphTo, readSeed, type HistorySeed } from '@/lib/card-morph';
import { dayShift, settle } from '@/lib/motion';
import { useResource } from '@/hooks/use-resource';
import { bucketReadings, extremes, type Extreme } from '@/lib/chartBuckets';
import { describeDay } from '@/lib/chartSummary';
import { daysSpanned, earliestDay, rangeBounds, rangeProblem } from '@/lib/csvRange';
import { addDays, formatDayLong, formatDayShort, formatHour, formatTime, formatTimeSeconds, isDateString, today } from '@/lib/localDate';
import { cn } from '@/lib/utils';
import type { DaySummary, History as HistoryPayload, Reading, SensorType } from '@/types';

/** How long after a Reading arrives on the stream before the day is reloaded, so a burst costs one request. */
const LIVE_RELOAD_DELAY_MS = 2_000;
const ROWS_PER_PAGE = 100;

/**
 * One day of one Device's history: a chart, the day's numbers, and the Readings themselves.
 * The Device comes from the path and the day from `?date=`, defaulting to today, so a
 * day can be bookmarked and stepped through across midnight.
 */
export default function History() {
  const { deviceId: deviceIdParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const deviceId = Number(deviceIdParam);
  const dateParam = searchParams.get('date') ?? '';
  const followsToday = !isDateString(dateParam);
  // With no date in the URL the page follows today; a render after midnight moves it to the new day.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const date = followsToday ? today() : dateParam;

  // What the card knew, if History was opened from one: the header renders from it at once.
  // The way back is read once, since stepping to another day replaces the navigation state.
  const location = useLocation();
  const seed = readSeed(location.state, deviceId);
  const [back] = useState(() => seed?.back ?? '/');

  if (!Number.isInteger(deviceId) || deviceId <= 0) return <NoDevice />;

  const showDay = (day: string) => setSearchParams(day === today() ? {} : { date: day });

  // Keyed by Device only: a step to another day keeps the header and the day picker still while
  // the day's content slides across, rather than dropping back to placeholders.
  return (
    <DayView
      key={deviceId}
      deviceId={deviceId}
      date={date}
      seed={seed}
      back={back}
      followsToday={followsToday}
      onShowDay={showDay}
      onDayRolledOver={rerender}
    />
  );
}

function NoDevice() {
  usePageTitle('History');
  return (
    <div className="flex-1 space-y-6">
      <PageHeading title="History" subtitle="One day of a Device's Readings." />
      <Placeholder>
        <p className="font-medium">Pick a Device first</p>
        <p className="max-w-sm text-sm text-muted-foreground">Every card on the dashboard has a History button that opens that Device's day.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Go to the dashboard</Link>
        </Button>
      </Placeholder>
    </div>
  );
}

interface PageHeadingProps {
  title: string;
  subtitle: React.ReactNode;
  tag?: React.ReactNode;
  actions?: React.ReactNode;
  /** The Device this header names; it is then the end of the move from its dashboard card, and the start of the move back. */
  deviceId?: number;
  /** Where the back button goes: the dashboard, with the Campus filter it was opened from. */
  back?: string;
  /** The day's last temperature, beside the title. */
  readout?: React.ReactNode;
}

function PageHeading({ title, subtitle, tag, actions, deviceId, back = '/', readout }: PageHeadingProps) {
  const navigate = useNavigate();
  const goBack = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (deviceId === undefined || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    morphTo(
      headingScope(deviceId),
      () => navigate(back),
      () => cardScope(deviceId),
      (card) => {
        // Bring the card into view before the move lands on it, so the way back ends where the eye can follow.
        const box = card.getBoundingClientRect();
        if (box.top < 0 || box.bottom > window.innerHeight) window.scrollBy(0, box.top - (window.innerHeight - box.height) / 2);
      },
    );
  };
  return (
    <header data-device-heading={deviceId} className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <Button asChild variant="outline" size="icon" className="mt-0.5 shrink-0">
          <Link to={back} onClick={goBack} aria-label="Back to the dashboard">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <div className="min-w-0 space-y-1">
          {/* The name and its IDF/MDF tag are one piece of the move from the card. */}
          <div data-morph="closet" className="flex w-fit max-w-full flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">
              {title}
            </h1>
            {tag}
          </div>
          <p className="text-muted-foreground">{subtitle}</p>
        </div>
        {readout && <div className="ml-3 shrink-0 pt-1">{readout}</div>}
      </div>
      {actions}
    </header>
  );
}

/** The day's last Reading in the header: the dashboard card's readout, landed here. */
function LastReading({ tempF }: { tempF: number }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">Last Reading</p>
      <p data-morph="temp" className="w-fit text-3xl font-semibold tabular-nums leading-none tracking-tight">
        <NumberFlow value={tempF} />
        <span className="text-[0.5em] font-medium text-muted-foreground">°F</span>
      </p>
    </div>
  );
}

/**
 * The header subtitle: the Campus (which travels from the card), the hostname, and, once the day has
 * loaded, the sensor its board says it carries (firmware 6), so a Reading near a threshold is read
 * with that sensor's accuracy in mind. Older firmware names none, and then neither does this.
 */
const DeviceSubtitle = ({ campus, hostname, sensor = null }: { campus: string; hostname: string; sensor?: SensorType | null }) => (
  <>
    <span data-morph="campus" className="inline-block align-top">
      {campus}
    </span>{' '}
    · <span className="font-mono text-sm">{hostname}</span>
    {sensor !== null && <> · {sensor} sensor</>}
  </>
);

const ClosetTag = ({ type }: { type: 'IDF' | 'MDF' | null }) =>
  type && (
    <Badge variant="outline" className={cn(type === 'MDF' && 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300')}>
      {type}
    </Badge>
  );

interface DayViewProps {
  deviceId: number;
  date: string;
  /** What the dashboard card knew, when History was opened from one. */
  seed: HistorySeed | undefined;
  back: string;
  /** True when the URL names no day, so the page should move on to the next day at midnight. */
  followsToday: boolean;
  onShowDay: (day: string) => void;
  /** A Reading has arrived after the day on screen while the page follows today. */
  onDayRolledOver: () => void;
}

function DayView({ deviceId, date, seed, back, followsToday, onShowDay, onDayRolledOver }: DayViewProps) {
  const load = useCallback(() => getHistory(deviceId, date), [deviceId, date]);
  const { state, reload } = useResource(load);
  usePageTitle(state.status === 'ready' ? `${state.data.device.closet}, ${state.data.device.campus.name}` : 'History');

  // The day is reloaded, not patched, when a Reading for this Device lands on it: the
  // summary and the chart both change, and the server is the one that cuts the day.
  const loaded = state.status === 'ready' ? state.data : undefined;
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A live reload queued for one day must not land after a step to another.
  useEffect(() => () => clearTimeout(reloadTimer.current), [date]);

  // Which way the day moved, for the slide: later days come in from the right, earlier from the left.
  const [shown, setShown] = useState<{ date: string | undefined; direction: number }>({ date: undefined, direction: 0 });
  if (loaded !== undefined && loaded.date !== shown.date) {
    setShown({ date: loaded.date, direction: shown.date === undefined ? 0 : loaded.date > shown.date ? 1 : -1 });
  }
  // Under reduced motion the day crossfades in place: no offset, not even an instant one.
  const reduced = useReducedMotion();
  const direction = reduced ? 0 : shown.direction;
  const stream = useReadingStream({
    onReading: (event) => {
      if (loaded === undefined || event.device !== loaded.device.hostname) return;
      const at = event.reading.recordedAt;
      if (at >= loaded.to && followsToday) {
        // Past midnight on a page left open: the Reading belongs to the new day, so show that day.
        onDayRolledOver();
        return;
      }
      if (at < loaded.from || at >= loaded.to) return;
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void reload(), LIVE_RELOAD_DELAY_MS);
    },
    onReconnect: () => void reload(),
  });

  // Reset is an Admin's: a Viewer is not offered it, and the server refuses it anyway.
  const admin = useIsAdmin();
  const change = useChange();
  const reset = async () => {
    if ((await change.run(() => resetHistory(deviceId))).ok) await reload();
  };

  if (state.status === 'error') {
    return (
      <div className="flex-1 space-y-6">
        <PageHeading title="History" subtitle={formatDayLong(date)} back={back} />
        <Placeholder role="alert">
          <p className="flex items-center gap-2 text-sm">
            <AlertCircle className="size-4 text-destructive" aria-hidden />
            {state.message}
          </p>
          {state.message === 'Device not found' ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/">Back to the dashboard</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          )}
        </Placeholder>
      </div>
    );
  }

  const isToday = date === today();
  const last = loaded?.readings.at(-1);

  // The header is the same element whether it renders from the day or from the card's seed,
  // so it stays put (and the move from the card lands on it) while the day loads beneath.
  const heading = loaded ? (
    <PageHeading
      deviceId={deviceId}
      back={back}
      title={loaded.device.closet}
      subtitle={<DeviceSubtitle campus={loaded.device.campus.name} hostname={loaded.device.hostname} sensor={loaded.device.sensor} />}
      tag={<ClosetTag type={loaded.device.closetType} />}
      readout={last && <LastReading tempF={last.tempF} />}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          {/* A past day never changes, so only today says whether Readings are arriving. */}
          {isToday && <LiveStatus status={stream} />}
          <DownloadCsv deviceId={deviceId} closet={loaded.device.closet} campus={loaded.device.campus.name} date={loaded.date} retentionDays={loaded.retentionDays} />
          {/* Not gated on the day shown: reset is the whole history, and a junk board's Readings may all be on other days. */}
          {admin && <ResetButton closet={loaded.device.closet} disabled={change.pending} pending={change.pending} onConfirm={() => void reset()} />}
        </div>
      }
    />
  ) : seed ? (
    <PageHeading
      deviceId={deviceId}
      back={back}
      title={seed.closet}
      subtitle={<DeviceSubtitle campus={seed.campusName} hostname={seed.hostname} />}
      tag={<ClosetTag type={seed.closetType} />}
      readout={seed.tempF !== null && <LastReading tempF={seed.tempF} />}
      actions={<Skeleton className="h-8 w-64 rounded-md" />}
    />
  ) : (
    <HeadingSkeleton />
  );

  if (loaded === undefined) {
    return (
      <div className="flex-1 space-y-6" aria-busy aria-label="Loading the day">
        {heading}
        <DayBodySkeleton />
      </div>
    );
  }

  const { readings, summary } = loaded;
  const shownIsToday = loaded.date === today();

  return (
    <div className="flex-1 space-y-6">
      {heading}

      <motion.div className="space-y-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={settle}>
        {change.error && (
          <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
            {change.error}
          </p>
        )}

        <DayPicker date={date} onShowDay={onShowDay} />

        {/* The day itself: a step to another day slides it a short way in the direction of
            travel and crossfades, while the header and the picker above stay still. */}
        <div className="relative">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={loaded.date}
              className="space-y-6"
              custom={direction}
              variants={dayShift}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {loaded.truncated && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Info className="size-4 shrink-0" aria-hidden />
                  <span>
                    This day holds more Readings than History loads at once. The first <span className="tabular-nums">{readings.length.toLocaleString()}</span>{' '}
                    are shown, and the numbers, chart, and table cover only those.
                  </span>
                </p>
              )}

              <DaySummaryTiles summary={summary} readings={readings} />

              {readings.length === 0 ? (
                <Placeholder>
                  <p className="font-medium">No Readings on {formatDayShort(loaded.date)}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {shownIsToday
                      ? 'Nothing has arrived from this Device yet today. New Readings appear here as they come in.'
                      : 'This Device sent nothing that day, or its Readings have since been deleted.'}
                  </p>
                  {!shownIsToday && (
                    <Button variant="outline" size="sm" onClick={() => onShowDay(today())}>
                      Show today
                    </Button>
                  )}
                </Placeholder>
              ) : (
                <>
                  <DayChart history={loaded} />
                  <ReadingsTable readings={readings} date={loaded.date} />
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

interface ResetButtonProps {
  closet: string;
  disabled: boolean;
  pending: boolean;
  onConfirm: () => void;
}

/** Reset is destructive and permanent, so it sits behind a confirmation that names the Device. */
function ResetButton({ closet, disabled, pending, onConfirm }: ResetButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="text-destructive hover:text-destructive">
          <Trash2 aria-hidden />
          {pending ? 'Resetting…' : 'Reset history'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset the history of {closet}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every Reading this Device has ever sent is deleted, not just the day on screen. The Device itself stays and keeps reporting. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-destructive-solid text-destructive-solid-foreground hover:bg-destructive-solid/90">
            Delete all Readings
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DownloadCsvProps {
  deviceId: number;
  closet: string;
  campus: string;
  /** The day on screen: the range starts as that day alone. */
  date: string;
  /** How long Readings are kept: the longest range the server takes. */
  retentionDays: number;
}

/**
 * The CSV download: a range of days, the day on screen until changed, and two files over it, the
 * Device's Readings and its incidents. Each is a plain link, so the browser saves it as it streams in.
 */
function DownloadCsv({ deviceId, closet, campus, date, retentionDays }: DownloadCsvProps) {
  const [range, setRange] = useState({ from: date, to: date });
  const fromId = useId();
  const toId = useId();
  const last = today();
  const problem = rangeProblem(range.from, range.to, retentionDays);
  const bounds = problem === null ? rangeBounds(range.from, range.to) : null;
  const days = problem === null ? daysSpanned(range.from, range.to) : 0;
  return (
    // Each opening starts again from the day on screen.
    <Dialog onOpenChange={(open) => open && setRange({ from: date, to: date })}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Download aria-hidden />
          Download CSV
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download CSV</DialogTitle>
          <DialogDescription>
            {closet}, {campus}. The Readings, one row each with the local and UTC time, °F, °C, and humidity; and this Device's incidents over the same days. For
            Excel or a work order.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={fromId}>First day</Label>
            <input
              id={fromId}
              type="date"
              value={range.from}
              min={earliestDay(last, retentionDays)}
              max={last}
              onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))}
              className={cn(DATE_FIELD, 'w-full')}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={toId}>Last day</Label>
            <input
              id={toId}
              type="date"
              value={range.to}
              min={earliestDay(last, retentionDays)}
              max={last}
              onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))}
              className={cn(DATE_FIELD, 'w-full')}
            />
          </div>
        </div>
        <p aria-live="polite" className={cn('flex items-center gap-2 text-sm tabular-nums', problem === null ? 'text-muted-foreground' : 'text-destructive')}>
          {problem === null ? (
            `${days === 1 ? 'One day' : `${days} days`}, ${range.from === range.to ? formatDayShort(range.from) : `${formatDayShort(range.from)} to ${formatDayShort(range.to)}`}. Up to ${retentionDays} at a time.`
          ) : (
            <>
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              {problem}
            </>
          )}
        </p>
        <DialogFooter>
          <DownloadLink variant="outline" href={bounds && incidentsCsvUrl(bounds.from, bounds.to, deviceId)}>
            Download incidents
          </DownloadLink>
          <DownloadLink href={bounds && readingsCsvUrl(deviceId, range.from, range.to)}>Download Readings</DownloadLink>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A download as a button: a link while the range can be fetched, a disabled button while it cannot. */
function DownloadLink({ href, variant = 'default', children }: { href: string | null; variant?: 'default' | 'outline'; children: React.ReactNode }) {
  if (href === null) {
    return (
      <Button variant={variant} disabled>
        <Download aria-hidden />
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant={variant}>
      <a href={href} download>
        <Download aria-hidden />
        {children}
      </a>
    </Button>
  );
}

/** A native date field drawn as an input, so it sits with the buttons beside it as one control group. */
const DATE_FIELD =
  'h-9 pointer-coarse:min-h-11 rounded-md border border-input bg-transparent px-3 text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring';

interface DayPickerProps {
  date: string;
  onShowDay: (day: string) => void;
}

/** Previous, the day itself (a native date field, so any day is one pick away), next, and a way back to today. */
function DayPicker({ date, onShowDay }: DayPickerProps) {
  const isToday = date === today();
  // A future day from a hand-edited URL has nothing after it either.
  const isLatest = date >= today();
  return (
    <nav aria-label="Day" className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="icon" onClick={() => onShowDay(addDays(date, -1))} aria-label="Previous day">
        <ChevronLeft aria-hidden />
      </Button>
      <label className="relative">
        <span className="sr-only">Day shown</span>
        <input
          type="date"
          value={date}
          max={today()}
          onChange={(event) => {
            if (isDateString(event.target.value)) onShowDay(event.target.value);
          }}
          className={DATE_FIELD}
        />
      </label>
      <Button variant="outline" size="icon" onClick={() => onShowDay(addDays(date, 1))} disabled={isLatest} aria-label="Next day">
        <ChevronRight aria-hidden />
      </Button>
      <p className="ml-1 text-sm font-medium">{isToday ? `Today, ${formatDayLong(date)}` : formatDayLong(date)}</p>
      {!isToday && (
        <Button variant="ghost" size="sm" onClick={() => onShowDay(today())}>
          Today
        </Button>
      )}
    </nav>
  );
}

const lowHigh = (s: DaySummary, unit: string): string => `Low ${s.min}${unit} · High ${s.max}${unit}`;

/** The day's numbers, in the dashboard's tiles: averages headline, lows and highs beneath. */
function DaySummaryTiles({ summary, readings }: { summary: HistoryPayload['summary']; readings: Reading[] }) {
  const span =
    readings.length === 0 ? 'None yet' : readings.length === 1 ? `At ${formatTime(readings[0].recordedAt)}` : `${formatTime(readings[0].recordedAt)} to ${formatTime(readings[readings.length - 1].recordedAt)}`;
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <Tile
        label="Average temperature"
        value={summary.tempF === null ? <NoValue /> : <NumberFlow value={summary.tempF.avg} suffix="°F" />}
        note={summary.tempF === null ? 'No Readings' : lowHigh(summary.tempF, '°')}
      />
      <Tile
        label="Average humidity"
        value={summary.humidity === null ? <NoValue /> : <NumberFlow value={summary.humidity.avg} suffix="%" />}
        note={summary.humidity === null ? (readings.length === 0 ? 'No Readings' : 'No humidity in these Readings') : lowHigh(summary.humidity, '%')}
      />
      <Tile label="Readings" value={<NumberFlow value={readings.length} />} note={span} />
    </dl>
  );
}

const chartConfig = {
  tempF: { label: 'Temperature', color: 'var(--chart-1)' },
  humidity: { label: 'Humidity', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const MS_PER_HOUR = 3_600_000;
/** How long the temperature line takes to draw across the day. */
const DRAW_MS = 700;

/** An axis range on multiples of five with a step of room either side, so ticks land on round numbers and a flat day is not a line along the edge. */
function niceDomain(values: number[], step = 5): [number, number] {
  if (values.length === 0) return [0, step];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [Math.floor((min - 1) / step) * step, Math.ceil((max + 1) / step) * step];
}

/**
 * The day's low or high, drawn where it happened with its raw value, so a spike the line's mean
 * smooths over is still on the chart. Small and in the series' own colour: a fact, not an alarm.
 */
const extremeDot = (axis: 'tempF' | 'humidity', point: Extreme, unit: string, color: string, below: boolean) => (
  <ReferenceDot
    key={`${axis}-${below ? 'low' : 'high'}`}
    yAxisId={axis}
    x={point.at}
    y={point.value}
    r={3}
    fill={color}
    stroke="var(--card)"
    strokeWidth={1.5}
    ifOverflow="extendDomain"
    label={{ value: `${point.value}${unit}`, position: below ? 'bottom' : 'top', offset: 6, fontSize: 11, fill: color, className: 'tabular-nums' }}
  />
);

/**
 * Both series over the whole day, midnight to midnight, so a quiet hour reads as a gap and not as
 * a shorter day. The lines are 5-minute means (lib/chartBuckets.ts), since the DHT11's whole-degree
 * flicker drawn raw is a solid block; the day's raw low and high are marked on top of them.
 */
function DayChart({ history }: { history: HistoryPayload }) {
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  // The bucket comes from the span the Readings cover, so a day that began an hour ago keeps minute detail.
  const data = useMemo(() => {
    const first = history.readings[0];
    const last = history.readings.at(-1);
    return bucketReadings(history.readings, from, first && last ? Date.parse(last.recordedAt) - Date.parse(first.recordedAt) : 0);
  }, [history.readings, from]);
  const tempRange = useMemo(() => extremes(history.readings, (r) => r.tempF), [history.readings]);
  const humidityRange = useMemo(() => extremes(history.readings, (r) => r.humidity), [history.readings]);
  // A tick every three hours from midnight; the closing midnight is the last one.
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = from; t <= to; t += 3 * MS_PER_HOUR) out.push(t);
    return out;
  }, [from, to]);
  // The axes cover the raw extremes, not just the means, so the marked low and high sit inside them.
  const tempDomain = useMemo(() => niceDomain(tempRange ? [tempRange.low.value, tempRange.high.value] : []), [tempRange]);
  const humidityDomain = useMemo(() => niceDomain(humidityRange ? [humidityRange.low.value, humidityRange.high.value] : []), [humidityRange]);
  // Dots on a few points help; on a full day of 30-second Readings they are noise.
  const sparse = data.length <= 48;
  // Mounted once per day shown (the day's content is keyed by date), so this is the day's first load.
  const reduced = useReducedMotion();
  const [drawing, setDrawing] = useState(!reduced);
  // The chart in words: each series' low and high and when, for a screen reader (the table below holds every value).
  const described = useMemo(() => describeDay(history.readings), [history.readings]);
  const describedId = `day-chart-${history.date}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Over the day
        </CardTitle>
        <CardDescription>Temperature on the left axis, humidity on the right.</CardDescription>
      </CardHeader>
      <CardContent>
        <p id={describedId} className="sr-only">
          {described}
        </p>
        {/* The arrow keys walk the chart's points once it has focus, so it shows the controls' focus ring. */}
        <ChartContainer
          config={chartConfig}
          role="figure"
          aria-label="Temperature and humidity over the day"
          aria-describedby={describedId}
          className="aspect-auto h-64 w-full sm:h-80 [&_.recharts-surface]:rounded-md [&_.recharts-surface:focus-visible]:outline-[3px] [&_.recharts-surface:focus-visible]:outline-ring/50"
        >
          <LineChart accessibilityLayer title="Temperature and humidity over the day" data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              scale="time"
              domain={[from, to]}
              ticks={ticks}
              tickFormatter={(value: number) => (value === to ? '12 AM' : formatHour(value))}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
            />
            {/* Whole degrees and whole percent, as the DHT11 reports them. */}
            <YAxis yAxisId="tempF" width={44} tickLine={false} axisLine={false} tickMargin={4} tickFormatter={(v: number) => `${v}°`} domain={tempDomain} allowDecimals={false} />
            <YAxis yAxisId="humidity" orientation="right" width={40} tickLine={false} axisLine={false} tickMargin={4} tickFormatter={(v: number) => `${v}%`} domain={humidityDomain} allowDecimals={false} />
            <ChartTooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_label, payload) => {
                    const point = payload?.[0]?.payload as { from: number; to: number; count: number } | undefined;
                    if (point === undefined) return '';
                    const readings = point.count === 1 ? 'one Reading' : `mean of ${point.count} Readings`;
                    return `${formatTime(point.from)} to ${formatTime(point.to)}, ${readings}`;
                  }}
                  formatter={(value, name) => (
                    <div className="flex flex-1 items-center justify-between gap-4">
                      <span className="text-muted-foreground">{chartConfig[name as keyof typeof chartConfig]?.label ?? name}</span>
                      <span className="font-medium tabular-nums">
                        {value}
                        {name === 'tempF' ? '°F' : '%'}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {/* The temperature line draws once, left to right, when a day first loads; a live reload of the same day never redraws it. */}
            <Line
              yAxisId="tempF"
              dataKey="tempF"
              type="monotone"
              stroke="var(--color-tempF)"
              strokeWidth={2}
              dot={sparse}
              activeDot={{ r: 4 }}
              isAnimationActive={drawing}
              animationDuration={DRAW_MS}
              animationEasing="ease-out"
              onAnimationEnd={() => setDrawing(false)}
            />
            <Line yAxisId="humidity" dataKey="humidity" type="monotone" stroke="var(--color-humidity)" strokeWidth={2} strokeDasharray="4 3" dot={sparse} activeDot={{ r: 4 }} isAnimationActive={false} />
            {/* Called, not rendered as components: Recharts only draws a ReferenceDot that is its direct child. */}
            {tempRange && tempRange.high.value !== tempRange.low.value && [
              extremeDot('tempF', tempRange.high, '°', 'var(--color-tempF)', false),
              extremeDot('tempF', tempRange.low, '°', 'var(--color-tempF)', true),
            ]}
            {humidityRange && humidityRange.high.value !== humidityRange.low.value && [
              extremeDot('humidity', humidityRange.high, '%', 'var(--color-humidity)', false),
              extremeDot('humidity', humidityRange.low, '%', 'var(--color-humidity)', true),
            ]}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Every Reading of the day, newest first, a page at a time so a full day of 2,880 Readings stays quick. */
function ReadingsTable({ readings, date }: { readings: Reading[]; date: string }) {
  const [page, setPage] = useState(1);
  const newestFirst = useMemo(() => readings.slice().reverse(), [readings]);
  const pages = Math.max(1, Math.ceil(newestFirst.length / ROWS_PER_PAGE));
  const current = Math.min(page, pages);
  const start = (current - 1) * ROWS_PER_PAGE;
  const rows = newestFirst.slice(start, start + ROWS_PER_PAGE);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Readings
        </CardTitle>
        <CardDescription>
          Newest first. {readings.length === 1 ? 'One Reading' : `${readings.length.toLocaleString()} Readings`} on {formatDayShort(date)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* The page keeps its shape whatever the day holds: the rows scroll inside, under a header that stays put. */}
        {/* A region that scrolls is a tab stop of its own, named, so a keyboard can scroll it and a screen reader knows what it holds. */}
        <div
          role="region"
          aria-label={`Readings on ${formatDayShort(date)}, newest first`}
          tabIndex={0}
          className="max-h-[30rem] overflow-y-auto rounded-md border outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring"
        >
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="pl-4">Time</TableHead>
              <TableHead className="text-right">Temperature</TableHead>
              <TableHead className="pr-4 text-right">Humidity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((reading, i) => (
              // Two Readings can share a second (a board retrying a POST), so the instant alone is not a key.
              <TableRow key={`${reading.recordedAt}#${start + i}`}>
                <TableCell className="pl-4 tabular-nums">
                  <time dateTime={reading.recordedAt}>{formatTimeSeconds(reading.recordedAt)}</time>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{reading.tempF}°F</TableCell>
                <TableCell className="pr-4 text-right tabular-nums">
                  {reading.humidity === null ? <span className="text-muted-foreground">—</span> : `${reading.humidity}%`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
        {pages > 1 && (
          <nav aria-label="Readings pages" className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <p className="text-sm text-muted-foreground tabular-nums">
              {start + 1}–{Math.min(start + ROWS_PER_PAGE, newestFirst.length)} of {newestFirst.length.toLocaleString()}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(current - 1)} disabled={current === 1}>
                Newer
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(current + 1)} disabled={current === pages}>
                Older
              </Button>
            </div>
          </nav>
        )}
      </CardContent>
    </Card>
  );
}

/** The header's shape while the day loads and no card handed over what it knew. */
function HeadingSkeleton() {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="mt-0.5 size-9 rounded-md" />
      <div className="space-y-1">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-6 w-64" />
      </div>
    </div>
  );
}

/** Everything under the header, in the shape it will take, so the day lands without a jump. */
function DayBodySkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="ml-1 h-4 w-56" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-[6.5rem] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
