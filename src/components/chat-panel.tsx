import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
import {
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  BugIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon
} from "@phosphor-icons/react";
import type { BillingAssistant } from "../server";
import { monthLabel, monthsAgo } from "../client-api";
import { ToolPart } from "./tool-part";

function suggestions() {
  const last = monthLabel(monthsAgo(1));
  const before = monthLabel(monthsAgo(2));
  return [
    `Why did my bill change from ${before} to ${last}?`,
    `Explain my ${last} invoice.`,
    `Was there a usage spike in ${last}?`,
    `Please credit $5.00 on my ${last} invoice for the outage on the 16th.`
  ];
}

/**
 * Chat with the billing assistant. Each customer has their own agent
 * instance (named by customer id), so chat history is per customer.
 */
export function ChatPanel({
  customerId,
  onTurnComplete
}: {
  customerId: string;
  /** Called when the assistant finishes a response, e.g. to refresh billing data */
  onTurnComplete: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<BillingAssistant>({
    agent: "BillingAssistant",
    name: customerId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({ agent, experimental_throttle: 100 });

  const isStreaming = status === "streaming" || status === "submitted";

  // Notify when a response finishes (streaming → idle)
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onTurnComplete();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onTurnComplete]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    },
    [isStreaming, sendMessage]
  );

  return (
    <div className="flex flex-col min-h-0 h-full bg-kumo-elevated">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-5 py-2 border-b border-kumo-line bg-kumo-base">
        <div className="flex items-center gap-1.5">
          <CircleIcon
            size="0.5rem"
            weight="fill"
            className={connected ? "text-kumo-success" : "text-kumo-danger"}
          />
          <Text size="xs" variant="secondary">
            {connected ? "Connected" : "Disconnected"}
          </Text>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <BugIcon size="0.875rem" className="text-kumo-inactive" />
            <Switch
              checked={showDebug}
              onCheckedChange={setShowDebug}
              size="sm"
              aria-label="Toggle debug mode"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<TrashIcon size="0.875rem" />}
            onClick={clearHistory}
          >
            Clear chat
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              className="px-4 sm:px-10"
              icon={<ChatCircleDotsIcon size="2rem" />}
              title="Ask about this account's billing"
              contents={
                <div className="flex max-w-full flex-wrap justify-center gap-2">
                  {suggestions().map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      className="max-w-full h-auto whitespace-normal py-1.5"
                      disabled={isStreaming || !connected}
                      onClick={() => send(prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[0.6875rem] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}
                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;
                  if (isToolUIPart(part)) {
                    return (
                      <ToolPart
                        key={key}
                        part={part}
                        onApproval={addToolApprovalResponse}
                      />
                    );
                  }
                  if (part.type !== "text" || !part.text) return null;
                  if (isUser) {
                    return (
                      <div key={key} className="flex justify-end">
                        <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                          {part.text}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={key} className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                        <Streamdown
                          className="sd-theme rounded-2xl rounded-bl-md p-3"
                          plugins={{ code }}
                          controls={false}
                          isAnimating={isLastAssistant && isStreaming}
                        >
                          {part.text}
                        </Streamdown>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Ask about usage, invoices, or charges..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 min-w-0 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size="1.125rem" />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size="1.125rem" />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}
