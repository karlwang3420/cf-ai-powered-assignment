import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { UsersThreeIcon } from "@phosphor-icons/react";
import type { DemoStatus } from "../demo/session";
import { api } from "../client-api";

const POLL_MS = 30_000;

/**
 * Hosted demo only: everyone who signs in shares one copy of the data. Says
 * when it resets, whether someone else is using it, and offers a reset;
 * renders nothing in local dev. Status is re-read while the page is open.
 */
export function DemoBanner() {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reset this page loaded after; a later one means its data is gone
  const loadedAfter = useRef<string | null | undefined>(undefined);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    api
      .demo()
      .then((s) => {
        if (!mounted.current || !s.enabled) return;
        if (loadedAfter.current === undefined)
          loadedAfter.current = s.lastResetAt;
        setStatus(s);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  if (!status) return null;
  const resetElsewhere =
    loadedAfter.current !== undefined &&
    status.lastResetAt !== loadedAfter.current;

  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await api.resetDemo();
      // Every panel and chat holds data from before the reset
      location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
      setResetting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="px-5 py-2 bg-kumo-base border-b border-kumo-line flex flex-wrap items-center gap-x-3 gap-y-2">
      <UsersThreeIcon size="1rem" className="text-kumo-subtle shrink-0" />
      <Text size="xs" variant="secondary">
        Shared demo: everyone who signs in sees the same data. It returns to the
        seed when someone new signs in after {status.idleMinutes} minutes
        without activity.
        {status.othersActive &&
          ` Someone else has used it in the last ${status.idleMinutes} minutes.`}
        {resetElsewhere &&
          " The demo has been reset since this page loaded; reload to see it."}
        {error && ` ${error}`}
      </Text>
      <div className="flex items-center gap-2 ml-auto">
        {resetElsewhere && !confirming && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => location.reload()}
          >
            Reload
          </Button>
        )}
        {confirming ? (
          <>
            <Text size="xs" variant="secondary">
              Reset every customer's invoices, payments, credits and chats for
              everyone?
            </Text>
            <Button
              size="sm"
              variant="destructive"
              disabled={resetting}
              onClick={() => void reset()}
            >
              {resetting ? "Resetting…" : "Reset"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={resetting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setConfirming(true);
              // Warn from current activity, not what was true at load
              refresh();
            }}
          >
            Reset demo
          </Button>
        )}
      </div>
    </div>
  );
}
