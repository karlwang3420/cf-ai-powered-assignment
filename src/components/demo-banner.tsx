import { useEffect, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { UsersThreeIcon } from "@phosphor-icons/react";
import type { DemoStatus } from "../demo/session";
import { api } from "../client-api";

/**
 * Hosted demo only: everyone who signs in shares one copy of the data. Says
 * when it resets and offers a reset; renders nothing in local dev.
 */
export function DemoBanner() {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api
      .demo()
      .then((s) => !stale && s.enabled && setStatus(s))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  if (!status) return null;

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
        {error && ` ${error}`}
      </Text>
      <div className="flex items-center gap-2 ml-auto">
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
            onClick={() => setConfirming(true)}
          >
            Reset demo
          </Button>
        )}
      </div>
    </div>
  );
}
