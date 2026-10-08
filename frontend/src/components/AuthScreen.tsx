import type { ReactNode } from 'react';
import { MonitorCog } from 'lucide-react';

interface AuthScreenProps {
  title: string;
  description: ReactNode;
  children: ReactNode;
}

/**
 * The page around signing in and choosing a first password: no sidebar, since nothing else can be
 * reached yet; the district's mark, one heading, and a card on Panel Grey in the middle of the page.
 */
export function AuthScreen({ title, description, children }: AuthScreenProps) {
  return (
    <main id="main" className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <MonitorCog className="size-4" aria-hidden />
          </div>
          <div className="grid text-sm leading-tight">
            <span className="font-medium">Celina ISD</span>
            <span className="text-xs text-muted-foreground">Temperature Monitor</span>
          </div>
        </div>
        <div className="space-y-6 rounded-xl border bg-card p-6 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
