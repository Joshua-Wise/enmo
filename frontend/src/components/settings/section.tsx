import { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, Check, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
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
import type { ChangeResult } from '@/hooks/use-change';
import { crossfade } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** Title, one-line purpose, and the section's primary action, laid out the same in every tab. */
interface SectionHeaderProps {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
}

export function SectionHeader({ id, title, description, action }: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h2 id={id} className="text-lg font-semibold leading-none">
          {title}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * What the last change did, said once, where a screen reader hears it and a sighted user
 * sees it: "ESP_A1B2C3 added." Rendered even when empty so the live region exists before
 * the message lands and is announced.
 */
export function StatusLine({ message }: { message: string | null }) {
  return (
    <p
      key={message}
      role="status"
      className={cn('flex items-center gap-2 text-sm', message === null ? 'sr-only' : 'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200')}
    >
      {message !== null && (
        <>
          <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {message}
        </>
      )}
    </p>
  );
}

/** A data row that fades in when it is added and out when it is deleted. Render inside an AnimatePresence. */
const MotionRow = motion.create(TableRow);
export function AnimatedRow(props: React.ComponentProps<typeof MotionRow>) {
  return <MotionRow {...crossfade} {...props} />;
}

/** Placeholder rows shaped like the data, shown while a list loads. */
export function SkeletonRows({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <TableRow key={row} aria-hidden>
          {Array.from({ length: columns }, (_, column) => (
            <TableCell key={column}>
              <Skeleton className={cn('h-4', column === columns - 1 ? 'ml-auto w-6' : column === 0 ? 'w-40' : 'w-16')} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

/** A full-width row for empty and error states. */
export function MessageRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="whitespace-normal py-10 text-center">
        {children}
      </TableCell>
    </TableRow>
  );
}

export function EmptyRow({ colSpan, title, hint }: { colSpan: number; title: string; hint: string }) {
  return (
    <MessageRow colSpan={colSpan}>
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">{hint}</p>
    </MessageRow>
  );
}

export function ErrorRow({ colSpan, message, onRetry }: { colSpan: number; message: string; onRetry: () => void }) {
  return (
    <MessageRow colSpan={colSpan}>
      <div className="flex flex-col items-center gap-3">
        <p className="flex items-center gap-2 text-sm">
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
          {message}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </MessageRow>
  );
}

/** An inline message for a failed change, shown next to the thing that failed. */
export function InlineError({ message, id }: { message: string | null; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

/** A field's hint: always present, so it is still there when an error appears above it. */
export function FieldHint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="max-w-prose text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** A cell that may hold a long name: wraps rather than forcing the table wider than the screen. */
export function WrappingCell({ className, ...props }: React.ComponentProps<typeof TableCell>) {
  return <TableCell className={cn('max-w-[18rem] whitespace-normal break-words', className)} {...props} />;
}

/** The panel an inline form (add or edit) sits in, so every form in Settings looks the same. */
export function InlineForm({ onSubmit, children, ...props }: React.ComponentProps<'form'>) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-3 rounded-lg border bg-muted/40 p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200"
      {...props}
    >
      {children}
    </form>
  );
}

interface DeleteButtonProps {
  label: string;
  title: string;
  description: string;
  disabled?: boolean;
  /** The message a failed delete produced, shown inside the open dialog. */
  error: string | null;
  onConfirm: () => Promise<ChangeResult>;
  /** The dialog closed without deleting: clear any error it was showing. */
  onDismiss: () => void;
}

/**
 * A row's delete action, behind a confirmation, with a pending state while it runs.
 * A delete the server refuses (a Campus that still has Devices) keeps the dialog open
 * and says why there, next to the button that was pressed; a rejected token closes it,
 * because the token prompt behind it takes over.
 */
export function DeleteButton({ label, title, description, disabled, error, onConfirm, onDismiss }: DeleteButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const setOpenState = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) onDismiss();
  };

  const confirm = async (event: React.MouseEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      const result = await onConfirm();
      if (result.ok || result.reason === 'unauthorised') setOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpenState}>
      <AlertDialogTrigger asChild>
        {/* DESIGN.md: a destructive flow starts from an outline button in Critical Red. */}
        <Button
          variant="outline"
          size="icon-sm"
          disabled={disabled}
          aria-label={label}
          title={label}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 aria-hidden />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <InlineError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirm}
            disabled={pending}
            className="bg-destructive-solid text-destructive-solid-foreground hover:bg-destructive-solid/90 focus-visible:ring-destructive/40"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
