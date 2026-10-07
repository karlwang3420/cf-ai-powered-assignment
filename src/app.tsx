import { Suspense, useCallback, useEffect, useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import {
  ChatCircleDotsIcon,
  MoonIcon,
  ReceiptIcon,
  SunIcon
} from "@phosphor-icons/react";
import type { CustomerSummary } from "./billing/store";
import { api } from "./client-api";
import { BillingPanel } from "./components/billing-panel";
import { ChatPanel } from "./components/chat-panel";

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function Shell() {
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(
    () => localStorage.getItem("customerId") ?? "cus_acme"
  );
  // Bumped after each assistant response, since an approved credit changes billing data
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

  useEffect(() => {
    api
      .customers()
      .then((list) => {
        setCustomers(list);
        // Fall back if the saved customer no longer exists (e.g. after a reset)
        if (list.length > 0 && !list.some((c) => c.id === customerId)) {
          setCustomerId(list[0].id);
        }
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [customerId]);

  const selectCustomer = (id: string) => {
    localStorage.setItem("customerId", id);
    setCustomerId(id);
  };

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default whitespace-nowrap">
              <ReceiptIcon size={20} className="inline mr-2 align-[-3px]" />
              Billing Assistant
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Llama 3.3
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2">
              <Text size="xs" variant="secondary">
                Customer
              </Text>
              <select
                className="px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
                value={customerId}
                onChange={(e) => selectCustomer(e.target.value)}
                disabled={!customers}
              >
                {(customers ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {loadError ? (
        <div className="p-8">
          <Text size="sm" variant="secondary">
            Could not load customers: {loadError}. Run{" "}
            <code>npm run db:setup</code> and reload.
          </Text>
        </div>
      ) : (
        <main className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <aside className="lg:w-[400px] shrink-0 max-h-[45vh] lg:max-h-none overflow-y-auto border-b lg:border-b-0 lg:border-r border-kumo-line bg-kumo-base">
            <BillingPanel customerId={customerId} refreshKey={refreshKey} />
          </aside>
          <section className="flex-1 min-h-0 min-w-0">
            {/* Remount per customer: each customer has their own chat agent */}
            <ChatPanel
              key={customerId}
              customerId={customerId}
              onTurnComplete={refresh}
            />
          </section>
        </main>
      )}
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Shell />
      </Suspense>
    </Toasty>
  );
}
