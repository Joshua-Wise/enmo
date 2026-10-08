import { Fragment, useState } from 'react';
import { AlertCircle, Check, CircleMinus, RefreshCw } from 'lucide-react';
import { getSystemHealth } from '@/api';
import { Button } from '@/components/ui/button';
import { useResource } from '@/hooks/use-resource';
import { systemLines, systemSummary, type SystemLine } from '@/lib/systemHealth';
import { cn } from '@/lib/utils';
import { InlineError, SectionHeader } from './section';

interface SystemSectionProps {
  /** True for an Admin: the lines are an Admin's to read. */
  canEdit: boolean;
}

const timeOf = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Whether the system itself is OK: the database and the disk, the last backup, email
 * notifications, firmware, the boards' WiFi, and the server. Each line is the server's
 * verdict (GET /api/system); a line that is not fine says what to do. Shown here only: a bad
 * line sends no email.
 */
export function SystemSection({ canEdit }: SystemSectionProps) {
  return (
    <section className="space-y-4" aria-labelledby="system-heading">
      <SectionHeader
        id="system-heading"
        title="System"
        description="Whether the server, its database, and the boards' links are OK. A line that is not fine says what to do; nothing here is emailed."
      />
      {canEdit ? <SystemLines /> : <p className="text-sm text-muted-foreground">Only an Admin sees whether the system is OK.</p>}
    </section>
  );
}

function SystemLines() {
  const { state, reload } = useResource(getSystemHealth);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  const lines = state.status === 'ready' ? systemLines(state.data, timeOf) : null;

  return (
    <>
      {state.status === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.status === 'error' && <InlineError message={`Could not load the system health. ${state.message}`} />}
      {state.status !== 'loading' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            {lines !== null && <span className="font-medium">{systemSummary(lines)}</span>}{' '}
            {state.status === 'ready' && <span className="text-muted-foreground tabular-nums">Checked {timeOf(state.data.checkedAt)}.</span>}
          </p>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'motion-safe:animate-spin' : undefined} aria-hidden />
            Refresh
          </Button>
        </div>
      )}
      {lines !== null && (
        <ul aria-label="System health" className="divide-y rounded-lg border text-sm">
          {lines.map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </ul>
      )}
    </>
  );
}

const STATUS: Record<SystemLine['status'], { word: string; icon: typeof Check; className: string }> = {
  ok: { word: 'Fine', icon: Check, className: 'text-muted-foreground' },
  off: { word: 'Off', icon: CircleMinus, className: 'text-muted-foreground' },
  attention: { word: 'Needs attention', icon: AlertCircle, className: 'text-destructive' },
};

/** One line: the server's verdict as an icon and a word for screen readers, the fact, and the fix. */
function Line({ line }: { line: SystemLine }) {
  const { word, icon: Icon, className } = STATUS[line.status];
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words">
          <span className="font-medium">{line.label}</span>
          <span className="sr-only"> ({word})</span>
          {': '}
          <span className={cn('tabular-nums', line.status === 'ok' && 'text-muted-foreground')}>
            <Rich text={line.fact} />
          </span>
        </p>
        {line.fix !== null && (
          <p className={cn('break-words', line.status === 'attention' ? 'text-destructive' : 'text-muted-foreground')}>
            <Rich text={line.fix} />
          </p>
        )}
      </div>
    </li>
  );
}

/** Text with `commands` set as code and Device hostnames in mono, as everywhere else. */
function Rich({ text }: { text: string }) {
  return text.split(/(`[^`]+`|ESP_[0-9A-F]{6})/).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^ESP_[0-9A-F]{6}$/.test(part)) {
      return (
        <span key={i} className="font-mono">
          {part}
        </span>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
