import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  GearIcon,
  HandCoinsIcon,
  MagnifyingGlassIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { monthLabel } from "../client-api";

const TOOL_LABELS: Record<string, string> = {
  getAccountOverview: "Checked account overview",
  getInvoice: "Read invoice",
  getUsage: "Read usage",
  compareMonths: "Compared months",
  getDailyUsage: "Read daily usage",
  issueCredit: "Credit"
};

type CreditInput = { month?: string; amount?: string; reason?: string };

function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.values(input as Record<string, unknown>)
    .filter((v) => typeof v === "string")
    .join(", ");
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function creditSummary(input: CreditInput) {
  return `$${input.amount ?? "?"} on the ${input.month ? monthLabel(input.month) : "?"} invoice`;
}

export function ToolPart({
  part,
  onApproval
}: {
  part: UIMessage["parts"][number];
  onApproval: (response: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);
  const label = TOOL_LABELS[name] ?? name;
  const isCredit = name === "issueCredit";
  const credit = (part.input ?? {}) as CreditInput;

  // A person approves or rejects every credit the assistant proposes
  if (part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string } | undefined)?.id;
    return (
      <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning space-y-2">
        <div className="flex items-center gap-2">
          <HandCoinsIcon size="1rem" className="text-kumo-warning" />
          <Text size="sm" bold>
            Approve credit of {creditSummary(credit)}?
          </Text>
        </div>
        {credit.reason && (
          <Text size="xs" variant="secondary">
            Reason: {credit.reason}
          </Text>
        )}
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<CheckCircleIcon size="0.875rem" />}
            onClick={() =>
              approvalId && onApproval({ id: approvalId, approved: true })
            }
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<XCircleIcon size="0.875rem" />}
            onClick={() =>
              approvalId && onApproval({ id: approvalId, approved: false })
            }
          >
            Reject
          </Button>
        </div>
      </Surface>
    );
  }

  if (part.state === "output-denied") {
    return (
      <div className="flex items-center gap-2 px-1">
        <XCircleIcon size="0.875rem" className="text-kumo-danger" />
        <Text size="xs" variant="secondary">
          {isCredit
            ? `Credit of ${creditSummary(credit)} rejected`
            : `${label} rejected`}
        </Text>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-danger">
        <div className="flex items-center gap-2">
          <XCircleIcon size="0.875rem" className="text-kumo-danger" />
          <Text size="xs" bold>
            {isCredit
              ? `Credit of ${creditSummary(credit)} not applied`
              : `${label} failed`}
          </Text>
        </div>
        <Text size="xs" variant="secondary">
          {part.errorText}
        </Text>
      </Surface>
    );
  }

  if (part.state === "output-available") {
    if (isCredit) {
      return (
        <div className="flex items-center gap-2 px-1 text-kumo-success">
          <CheckCircleIcon size="0.875rem" />
          <Text size="xs">Credit of {creditSummary(credit)} applied</Text>
        </div>
      );
    }
    // Read-only lookups stay compact; expand to see the exact data the model got
    return (
      <details className="max-w-[85%] px-1 group">
        <summary className="flex items-center gap-2 cursor-pointer select-none list-none">
          <MagnifyingGlassIcon size="0.875rem" className="text-kumo-inactive" />
          <Text size="xs" variant="secondary">
            {label}
            {describeInput(part.input) && ` (${describeInput(part.input)})`}
          </Text>
          <Badge variant="secondary">data</Badge>
        </summary>
        <div className="mt-1 rounded-lg bg-kumo-control p-2">
          <Json label="Input" value={part.input} />
          <Json label="Output" value={part.output} />
        </div>
      </details>
    );
  }

  return (
    <div className="flex items-center gap-2 px-1">
      <GearIcon size="0.875rem" className="text-kumo-inactive animate-spin" />
      <Text size="xs" variant="secondary">
        {label}…
      </Text>
    </div>
  );
}
