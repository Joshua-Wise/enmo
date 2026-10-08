import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrowserRouter as Router, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { motion, MotionConfig } from 'framer-motion';
import { isMorphing } from '@/lib/card-morph';
import { EASE_OUT_QUINT } from '@/lib/motion';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Incidents from './pages/Incidents';
import Campuses from './pages/Campuses';
import NotFound from './pages/NotFound';
import { historyModule } from './pages/history-loader';
import { Skeleton } from '@/components/ui/skeleton';
import { NewDevicePrompt } from '@/components/NewDevicePrompt';
import { Placeholder } from '@/components/Placeholder';
import { Button } from '@/components/ui/button';
import { describeError, getSession, UnauthorisedError } from '@/api';
import { useSession } from '@/hooks/use-session';
import { setSession } from '@/lib/session';
import { returnPath, signInPath, SIGN_IN_PATH } from '@/lib/signIn';
import SignIn from './pages/SignIn';
import ChoosePassword from './pages/ChoosePassword';

// History carries the charting library, which is a third of the bundle and unused elsewhere, so it loads on first visit
// (or while the dashboard idles; see history-loader).
const History = lazy(historyModule);

/** The shape of a page while its code arrives: a heading and a block, so nothing jumps when it lands. */
function PageLoading() {
  return (
    <div className="flex-1 space-y-6" aria-busy aria-label="Loading the page">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
import { AppSidebar } from "@/components/app-sidebar"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"


// A page settles in with a short rise and a fade. There is no exit: the old page goes at once,
// so a click is answered on the next frame instead of after a fade-out. Reduced motion
// (MotionConfig below) drops the rise and keeps the fade. During the card-to-History move the
// rise is skipped too, since the header the move lands on must already be in its place.
const pageTransition = { duration: 0.22, ease: EASE_OUT_QUINT };

function Page({ children }: { children: React.ReactNode }) {
  const [rise] = useState(() => (isMorphing() ? 0 : 8));
  return (
    <motion.div initial={{ opacity: 0, y: rise }} animate={{ opacity: 1, y: 0 }} transition={pageTransition}>
      {children}
    </motion.div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  // A new page starts at its top; a day or filter change (same path) keeps the scroll.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  // A new page is announced by its heading: focus moves there, as a page load would start a screen
  // reader at the top, so a keyboard user carries on from the page and not the link that left it.
  // Not on the first load (the browser starts there anyway), and not on a filter or day change.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => focusPageStart());
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);

  return (
    <Routes location={location}>
      <Route path="/" element={<Page><Dashboard /></Page>} />
      <Route path="/campuses" element={<Page><Campuses /></Page>} />
      <Route path="/incidents" element={<Page><Incidents /></Page>} />
      <Route path="/settings" element={<Page><Settings /></Page>} />
      <Route
        path="/history/:deviceId?"
        element={
          <Page>
            <Suspense fallback={<PageLoading />}>
              <History />
            </Suspense>
          </Page>
        }
      />
      <Route path="*" element={<Page><NotFound /></Page>} />
    </Routes>
  );
}

const MAIN_ID = 'main';

/** The page's h1, or the content itself while the page is still arriving. */
function focusPageStart() {
  const target = document.querySelector<HTMLElement>(`#${MAIN_ID} h1`) ?? document.getElementById(MAIN_ID);
  if (target === null) return;
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** The pages, behind the sidebar: for someone signed in with a password of their own. */
function Shell() {
  return (
    <>
      {/* The first stop on every page, shown when focused: past the sidebar's links to the page itself. */}
      <a
        href={`#${MAIN_ID}`}
        onClick={(event) => {
          event.preventDefault();
          focusPageStart();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus:ring-[3px] focus:ring-ring"
      >
        Skip to content
      </a>
      <SidebarProvider>
        <AppSidebar />
        {/* min-w-0: the page may shrink to the space beside the sidebar; a wide table then scrolls in its own box instead of pushing the page past the window, where it was clipped. */}
        <SidebarInset className="min-w-0">
          <header className="flex h-16 shrink-0 items-center gap-2">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
            </div>
          </header>
          <div id={MAIN_ID} tabIndex={-1} className="flex flex-1 flex-col gap-4 p-4 pt-0 outline-none">
            <AnimatedRoutes />
          </div>
          <NewDevicePrompt />
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}

/**
 * Every page needs someone signed in (docs/adr/0010). Until the server says who, a quiet blank;
 * no one, the sign-in page, which returns to the page asked for; `admin` still on its first
 * password, nothing but choosing a new one; anyone else, the pages.
 */
function SessionGate() {
  const session = useSession();
  const location = useLocation();
  const [unreachable, setUnreachable] = useState<string | null>(null);

  const load = useCallback(() => {
    setUnreachable(null);
    getSession().then(setSession, (error: unknown) => {
      // A 401 has already ended the session (api.ts); anything else is a server that did not answer.
      if (!(error instanceof UnauthorisedError)) setUnreachable(describeError(error));
    });
  }, []);
  useEffect(load, [load]);

  if (session.status === 'loading') {
    if (unreachable === null) return <div className="min-h-svh bg-background" aria-busy aria-label="Loading" />;
    return (
      <main id={MAIN_ID} className="flex min-h-svh items-center justify-center bg-background p-4">
        <Placeholder role="alert" className="w-full max-w-md">
          <h1 className="font-medium">The server did not answer</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{unreachable}. Nothing can be shown until it does.</p>
          <Button variant="outline" size="sm" onClick={load}>
            Try again
          </Button>
        </Placeholder>
      </main>
    );
  }
  const onSignIn = location.pathname === SIGN_IN_PATH;
  if (session.status === 'signed-out') return onSignIn ? <SignIn /> : <Navigate to={signInPath(location)} replace />;
  if (session.mustChangePassword) return <ChoosePassword />;
  if (onSignIn) return <Navigate to={returnPath(location.search)} replace />;
  return <Shell />;
}

function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Router>
        <SessionGate />
      </Router>
    </MotionConfig>
  );
}

export default App;
