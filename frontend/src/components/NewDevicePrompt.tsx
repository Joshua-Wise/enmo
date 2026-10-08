import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPendingDevices, setPendingIgnored } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useIsAdmin } from '@/hooks/use-session';
import { boardsToAnnounce, promptKey } from '@/lib/newDevices';
import type { PendingDevice } from '@/types';

/** How often an Admin's page asks whether a new board has turned up. */
const POLL_MS = 30_000;
const STORAGE_KEY = 'temperature-alarms:new-devices-seen';

const loadDismissed = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const saveDismissed = (keys: Set<string>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys].slice(-200)));
  } catch {
    // Private mode or storage full: the pop-up may simply come back on the next load.
  }
};

/**
 * A pop-up, on any page, when a board starts reporting with the Device token without being added:
 * adopt it in Settings, or say not now (it stays listed under New devices). Only for an Admin, since
 * only they can see the list and adopt.
 */
export function NewDevicePrompt() {
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState<PendingDevice[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  useEffect(() => {
    if (!admin) {
      setWaiting([]);
      return;
    }
    let cancelled = false;
    const check = () =>
      getPendingDevices().then(
        (pending) => {
          if (!cancelled) setWaiting(pending);
        },
        () => {
          // A dropped connection: Settings says so; the pop-up just stays quiet.
        },
      );
    void check();
    const timer = window.setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [admin]);

  const announce = boardsToAnnounce(waiting, dismissed);
  const wave = (boards: PendingDevice[]) => {
    const next = new Set(dismissed);
    for (const board of boards) next.add(promptKey(board));
    setDismissed(next);
    saveDismissed(next);
  };

  const adopt = () => {
    const first = announce[0];
    wave(announce);
    navigate(`/settings?tab=new&adopt=${encodeURIComponent(first.hostname)}`);
  };
  const ignore = async () => {
    wave(announce);
    await Promise.allSettled(announce.map((board) => setPendingIgnored(board.hostname, true)));
  };

  const one = announce.length === 1;
  return (
    <Dialog open={announce.length > 0} onOpenChange={(open) => !open && wave(announce)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{one ? 'A new device is reporting' : `${announce.length} new devices are reporting`}</DialogTitle>
          <DialogDescription>
            {one ? 'This board sends' : 'These boards send'} Readings with the Device token but {one ? 'is' : 'are'} not added yet, so the Readings are refused.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-sm">
          {announce.slice(0, 5).map((board) => (
            <li key={board.hostname} className="flex flex-wrap justify-between gap-x-4">
              <span className="font-mono">{board.hostname}</span>
              <span className="tabular-nums text-muted-foreground">
                {board.lastReading === null ? 'no Reading yet' : `${board.lastReading.tempF} °F, ${board.lastReading.humidity} %`}
                {board.address !== null && ` · ${board.address}`}
              </span>
            </li>
          ))}
          {announce.length > 5 && <li className="text-muted-foreground">and {announce.length - 5} more</li>}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={ignore}>
            Ignore
          </Button>
          <Button variant="outline" onClick={() => wave(announce)}>
            Not now
          </Button>
          <Button onClick={adopt}>{one ? 'Adopt it' : 'Adopt in Settings'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
