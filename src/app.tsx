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
import { AdminPage } from "./components/admin-page";
import { BillingPanel } from "./components/billing-panel";
import { ChatPanel } from "./components/chat-panel";
import { DemoBanner } from "./components/demo-banner";

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
      icon={dark ? <SunIcon size="1rem" /> : <MoonIcon size="1rem" />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

type View = "customer" | "admin";
const viewFromPath = (): View =>
  location.pathname.replace(/\/+$/, "") === "/admin" ? "admin" : "customer";

/** Two pages share one SPA; pushState switches without a full reload. */
function useView(): [View, (next: View) => void] {
  const [view, setView] = useState(viewFromPath);
  useEffect(() => {
    const sync = () => setView(viewFromPath());
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const go = useCallback((next: View) => {
    history.pushState(null, "", next === "admin" ? "/admin" : "/");
    setView(next);
  }, []);
  return [view, go];
}

function ViewSwitch({
  view,
  onChange
}: {
  view: View;
  onChange: (next: View) => void;
}) {
  return (
    <nav
      className="flex rounded-lg border border-kumo-line p-0.5"
      aria-label="View"
    >
      {(["customer", "admin"] as const).map((v) => (
        <a
          key={v}
          href={v === "admin" ? "/admin" : "/"}
          aria-current={view === v ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            onChange(v);
          }}
          className={`px-3 py-1 text-sm rounded-md capitalize ${
            view === v
              ? "bg-kumo-elevated text-kumo-default font-medium"
              : "text-kumo-subtle"
          }`}
        >
          {v}
        </a>
      ))}
    </nav>
  );
}

function Shell() {
  const [view, setView] = useView();
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState(
    () => localStorage.getItem("customerId") ?? "cus_acme"
  );
  // Bumped after each assistant response, since an approved credit changes billing data
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

  useEffect(() => {
    let stale = false;
    api
      .customers()
      .then((list) => {
        if (stale) return;
        setLoadError(null);
        setCustomers(list);
        // Fall back if the saved customer no longer exists (e.g. after a reset)
        if (list.length > 0 && !list.some((c) => c.id === customerId)) {
          setCustomerId(list[0].id);
        }
      })
      .catch((e: Error) => !stale && setLoadError(e.message));
    return () => {
      stale = true;
    };
  }, [customerId]);

  const selectCustomer = (id: string) => {
    localStorage.setItem("customerId", id);
    setCustomerId(id);
  };

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default whitespace-nowrap">
              <ReceiptIcon
                size="1.25rem"
                className="inline mr-2 align-[-0.1875rem]"
              />
              Billing Assistant
            </h1>
            {view === "customer" && (
              <Badge variant="secondary">
                <ChatCircleDotsIcon
                  size="0.75rem"
                  weight="bold"
                  className="mr-1"
                />
                Llama 3.3
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 min-w-0 w-full sm:w-auto">
            <ViewSwitch view={view} onChange={setView} />
            <label
              className={`flex-1 items-center gap-2 min-w-0 ${view === "customer" ? "flex" : "hidden"}`}
            >
              <Text size="xs" variant="secondary">
                Customer
              </Text>
              <select
                className="w-full min-w-0 sm:w-auto sm:max-w-64 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
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
      <DemoBanner />

      {loadError ? (
        <div className="p-8">
          <Text size="sm" variant="secondary">
            Could not load customers: {loadError}. Run{" "}
            <code>npm run db:setup</code> and reload.
          </Text>
        </div>
      ) : view === "admin" ? (
        <main className="flex-1 min-h-0">
          {customers && <AdminPage customers={customers} />}
        </main>
      ) : (
        <main className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <aside className="lg:w-[25rem] min-w-0 wrap-anywhere shrink-0 max-h-[45vh] lg:max-h-none overflow-y-auto border-b lg:border-b-0 lg:border-r border-kumo-line bg-kumo-base">
            <BillingPanel
              key={customerId}
              customerId={customerId}
              refreshKey={refreshKey}
            />
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
