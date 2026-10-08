import { RefreshCw } from 'lucide-react';
import { getDeviceRotation } from '@/api';
import { useResource } from '@/hooks/use-resource';
import { rotationSummary } from '@/lib/rotation';

const timeOf = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * During a Device token rotation, the Devices still to reflash (docs/adr/0003). Shown only to
 * an Admin, and only while the server still accepts the previous token.
 */
export function RotationLine() {
  const { state } = useResource(getDeviceRotation);
  if (state.status !== 'ready') return null;
  const summary = rotationSummary(state.data, timeOf);
  if (summary === null) return null;
  return (
    <section aria-label="Device token rotation" className="flex items-start gap-3 rounded-lg border px-4 py-3 text-sm">
      <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="space-x-1">
        <span className="font-medium">Device token rotation under way.</span>
        <span>{summary.previous}</span>
        {summary.unheard !== null && <span className="text-muted-foreground">{summary.unheard}</span>}
        {summary.done && (
          <span className="text-muted-foreground">
            Every Device has the new token: finish with <code>deploy/deploy.sh rotate-device-token --finish</code>.
          </span>
        )}
      </p>
    </section>
  );
}
