import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * One codebase, every desktop. Chrome/Edge on Windows, macOS and Linux fire
 * `beforeinstallprompt`; we catch it and offer a real one-click install —
 * the app then lives in the taskbar/dock with its own window and works
 * offline. No Electron, no separate builds, no update shipping.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia('(display-mode: standalone)').matches,
  );

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  return {
    installed,
    canInstall: Boolean(deferred),
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
    },
  };
}

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

export function InstallPrompt({ compact = false }: { compact?: boolean }) {
  const { installed, canInstall, install } = useInstallPrompt();

  if (installed) {
    return compact ? null : (
      <p className="flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
        ✅ Installed on this {isMac ? 'Mac' : 'computer'} — launch it from your {isMac ? 'Dock / Launchpad' : 'taskbar / Start menu'}.
      </p>
    );
  }

  if (canInstall) {
    return (
      <button
        onClick={() => void install()}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 p-3 text-sm font-bold text-primary transition-transform active:scale-[.98]"
      >
        ⬇️ Install Sillara on this {isMac ? 'Mac' : 'computer'}
      </button>
    );
  }

  if (compact) return null;

  // Browsers that hide the event (Safari, Firefox) get the manual route.
  return (
    <p className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
      💡 Install as an app: {isIOS
        ? 'Share button → "Add to Home Screen".'
        : isMac
          ? 'in Chrome/Edge, click the install icon in the address bar (Safari: File → Add to Dock).'
          : 'in Chrome/Edge, click the install icon at the right of the address bar.'}
      {' '}It gets its own window and works offline.
    </p>
  );
}
