"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatThreadData } from "@/app/api/kv/chat-threads/[id]/route";
import type { ChatThreadManifestEntry } from "@/app/api/kv/chat-threads/route";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * /chat — dashboard chat with auto-injected portfolio context + web search.
 *
 * Architecture:
 *   - Sidebar lists threads from `pm:chat-threads` (manifest).
 *   - Clicking a thread loads its messages from `pm:chat-thread:{id}`.
 *   - Sending a message streams the response from `/api/chat` (SSE).
 *   - After each assistant turn completes, we PUT the updated thread back
 *     to Redis and refresh the manifest entry's `updatedAt` / `messageCount`.
 *   - First-message threads get a Claude-Haiku-generated title via
 *     `/api/chat/title` so the sidebar entry is something readable.
 */

function genId() {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Render assistant content as clean blocks. We intentionally normalize away
// the messy markdown shapes Claude sometimes emits (## headings, --- rules,
// pipe tables) into clean React elements so the output looks polished even
// if the model occasionally ignores formatting instructions in the prompt.
function renderMarkdown(text: string): React.ReactNode {
  // Pre-process: strip leading/trailing whitespace.
  const cleaned = text.trim();
  // Tokenize into block elements.
  const blocks: React.ReactNode[] = [];
  const rawLines = cleaned.split("\n");
  let i = 0;
  let key = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const stripped = line.trim();

    // Skip blank lines (used as paragraph separators).
    if (stripped === "") {
      i++;
      continue;
    }

    // Horizontal rule (---, ***, ___) — skip entirely, they add visual noise
    // in a chat bubble.
    if (/^([-*_])\1{2,}$/.test(stripped)) {
      i++;
      continue;
    }

    // Pipe table: 2+ "|" in a row AND next line is the separator (---|---).
    if (line.includes("|") && (line.match(/\|/g) || []).length >= 2) {
      const nextLine = rawLines[i + 1] ?? "";
      const isTable = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(nextLine);
      if (isTable) {
        // Collect rows: header (current), skip separator, then until non-table line.
        const headerCells = splitTableRow(line);
        const bodyRows: string[][] = [];
        let j = i + 2;
        while (j < rawLines.length && rawLines[j].includes("|") && rawLines[j].trim() !== "") {
          bodyRows.push(splitTableRow(rawLines[j]));
          j++;
        }
        blocks.push(
          <div key={key++} className="my-2 overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
              <thead>
                <tr>
                  {headerCells.map((c, ci) => (
                    <th key={ci} className="h-[30px] whitespace-nowrap border-b border-line px-2 text-left text-[11px] font-medium text-ink-3">
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((c, ci) => (
                      <td key={ci} className="border-b border-line-soft px-2 py-1.5 align-top text-ink">
                        {renderInline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        i = j;
        continue;
      }
    }

    // Headings: # / ## / ### → bolded sentences (no big font, matches chat tone).
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(stripped);
    if (hMatch) {
      const headingText = hMatch[2].replace(/[*_`]/g, "");
      blocks.push(
        <p key={key++} className="mb-1 mt-3 font-semibold text-ink first:mt-0">
          {renderInline(headingText)}
        </p>,
      );
      i++;
      continue;
    }

    // Bullet list: lines starting with "- " or "* " (consume consecutive lines).
    if (/^[-*]\s+/.test(stripped)) {
      const items: string[] = [];
      while (i < rawLines.length && /^[-*]\s+/.test(rawLines[i].trim())) {
        items.push(rawLines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="mb-3 list-disc space-y-1 pl-5 last:mb-0">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list: lines starting with "1. " etc.
    if (/^\d+\.\s+/.test(stripped)) {
      const items: string[] = [];
      while (i < rawLines.length && /^\d+\.\s+/.test(rawLines[i].trim())) {
        items.push(rawLines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: collect until blank line.
    const paraLines: string[] = [];
    while (i < rawLines.length && rawLines[i].trim() !== "" && !/^[-*]\s+/.test(rawLines[i].trim()) && !/^\d+\.\s+/.test(rawLines[i].trim()) && !/^#{1,6}\s+/.test(rawLines[i].trim())) {
      paraLines.push(rawLines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="mb-3 last:mb-0">
        {paraLines.map((l, idx) => (
          <span key={idx}>
            {renderInline(l)}
            {idx < paraLines.length - 1 && <br />}
          </span>
        ))}
      </p>,
    );
  }

  return blocks;
}

function splitTableRow(line: string): string[] {
  // Strip leading/trailing pipe, split on |, trim each.
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function renderInline(text: string): React.ReactNode {
  // Process bold (**) first, then italic (*), then links [text](url).
  const tokens: Array<{ type: "text" | "bold" | "italic" | "link" | "code"; content: string; url?: string }> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        tokens.push({ type: "bold", content: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith("`", i)) {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        tokens.push({ type: "code", content: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          tokens.push({ type: "link", content: text.slice(i + 1, close), url: text.slice(close + 2, urlEnd) });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // Plain text — accumulate up to next special.
    let j = i;
    while (j < text.length && text[j] !== "*" && text[j] !== "[" && text[j] !== "`") j++;
    tokens.push({ type: "text", content: text.slice(i, Math.max(j, i + 1)) });
    i = Math.max(j, i + 1);
  }
  return tokens.map((t, idx) => {
    if (t.type === "bold") return <strong key={idx}>{t.content}</strong>;
    if (t.type === "italic") return <em key={idx}>{t.content}</em>;
    if (t.type === "code") return <code key={idx} className="rounded-[4px] bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]">{t.content}</code>;
    if (t.type === "link") return <a key={idx} href={t.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{t.content}</a>;
    return <span key={idx}>{t.content}</span>;
  });
}

export default function ChatPage() {
  const [threads, setThreads] = useState<ChatThreadManifestEntry[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<ChatThreadData | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [contextEnabled, setContextEnabled] = useState(true);
  const [streamingText, setStreamingText] = useState(""); // live-updating assistant text
  const [streamingSearchEvents, setStreamingSearchEvents] = useState<Array<{ type: "query" | "citation"; text: string; url?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  // On mobile, sidebar is a drawer that defaults closed (so the chat area
  // gets the full screen). On md+ screens it's always visible.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Inline-rename state — when set, the sidebar row swaps to an input.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Load manifest on mount.
  useEffect(() => {
    fetch("/api/kv/chat-threads")
      .then((r) => r.json())
      .then((d) => {
        const list: ChatThreadManifestEntry[] = Array.isArray(d?.threads) ? d.threads : [];
        list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        setThreads(list);
      })
      .catch((e) => console.error("Failed to load chat threads:", e));
  }, []);

  // Load thread body when active id changes.
  useEffect(() => {
    if (!activeThreadId) {
      setActiveThread(null);
      return;
    }
    fetch(`/api/kv/chat-threads/${activeThreadId}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((d) => {
        if (d) setActiveThread(d as ChatThreadData);
      })
      .catch((e) => console.error("Failed to load thread:", e));
  }, [activeThreadId]);

  // Auto-scroll to bottom on new messages / streaming text.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeThread?.messages.length, streamingText]);

  const persistThread = useCallback(async (thread: ChatThreadData) => {
    await fetch(`/api/kv/chat-threads/${thread.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(thread),
    });
    // Update manifest entry.
    setThreads((prev) => {
      const filtered = prev.filter((t) => t.id !== thread.id);
      const entry: ChatThreadManifestEntry = {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.messages.length,
      };
      const next = [entry, ...filtered];
      // Persist manifest asynchronously.
      fetch("/api/kv/chat-threads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: next }),
      }).catch((e) => console.error("Failed to persist manifest:", e));
      return next;
    });
  }, []);

  const newThread = useCallback(() => {
    const id = genId();
    const thread: ChatThreadData = {
      id,
      title: "New chat",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      contextEnabled: true,
    };
    setActiveThread(thread);
    setActiveThreadId(id);
    setStreamingText("");
    setStreamingSearchEvents([]);
    setError(null);
  }, []);

  const deleteThread = useCallback(async (id: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    await fetch(`/api/kv/chat-threads/${id}`, { method: "DELETE" }).catch(() => {});
    setThreads((prev) => {
      const next = prev.filter((t) => t.id !== id);
      fetch("/api/kv/chat-threads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: next }),
      }).catch(() => {});
      return next;
    });
    if (activeThreadId === id) {
      setActiveThreadId(null);
      setActiveThread(null);
    }
  }, [activeThreadId]);

  // Begin inline rename — populates draft state and focuses the input on next tick.
  const beginRename = useCallback((id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameDraft(currentTitle);
    // Focus + select after React renders the input.
    setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft("");
  }, []);

  // Commit rename: writes the new title to both the manifest and the per-thread blob.
  const commitRename = useCallback(async () => {
    const id = renamingId;
    const newTitle = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (!id || !newTitle) return;

    // Optimistic local update to the manifest.
    let manifestSnapshot: ChatThreadManifestEntry[] = [];
    setThreads((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, title: newTitle } : t));
      manifestSnapshot = next;
      return next;
    });
    // Update the active thread state if it's the one being renamed.
    if (activeThread?.id === id) {
      setActiveThread({ ...activeThread, title: newTitle });
    }

    // Persist manifest + per-thread blob in parallel. The per-thread PUT
    // requires fetching the current blob first so we don't clobber messages.
    try {
      await fetch("/api/kv/chat-threads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: manifestSnapshot }),
      });
      const cur = await fetch(`/api/kv/chat-threads/${id}`).then((r) => (r.ok ? r.json() : null));
      if (cur && typeof cur === "object" && cur.id === id) {
        const updated: ChatThreadData = { ...(cur as ChatThreadData), title: newTitle, updatedAt: nowIso() };
        await fetch(`/api/kv/chat-threads/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        });
      }
    } catch (e) {
      console.error("Failed to rename thread:", e);
    }
  }, [activeThread, renameDraft, renamingId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setError(null);

    // Ensure a thread exists.
    let thread = activeThread;
    if (!thread) {
      const id = genId();
      thread = {
        id,
        title: "New chat",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        messages: [],
        contextEnabled,
      };
      setActiveThreadId(id);
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: "user",
      content: text,
      timestamp: nowIso(),
    };
    const isFirstMessage = thread.messages.length === 0;
    const updatedThread: ChatThreadData = {
      ...thread,
      messages: [...thread.messages, userMsg],
      updatedAt: nowIso(),
      contextEnabled,
    };
    setActiveThread(updatedThread);
    setInput("");
    setStreamingText("");
    setStreamingSearchEvents([]);
    setIsStreaming(true);

    try {
      // Stream the assistant response.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedThread.messages.map((m) => ({ role: m.role, content: m.content })),
          contextEnabled,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Chat request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      const queries: string[] = [];
      const citations: Array<{ url: string; title?: string }> = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n. Process each complete event.
        let sepIdx;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const dataLine = rawEvent.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "text" && typeof evt.delta === "string") {
              assistantText += evt.delta;
              setStreamingText(assistantText);
            } else if (evt.type === "search_query" && typeof evt.query === "string") {
              queries.push(evt.query);
              setStreamingSearchEvents((prev) => [...prev, { type: "query", text: evt.query }]);
            } else if (evt.type === "citation" && typeof evt.url === "string") {
              citations.push({ url: evt.url, title: evt.title ?? undefined });
              setStreamingSearchEvents((prev) => [...prev, { type: "citation", text: evt.title ?? evt.url, url: evt.url }]);
            } else if (evt.type === "error") {
              throw new Error(evt.error ?? "stream error");
            }
          } catch (parseErr) {
            console.error("Failed to parse SSE event:", payload, parseErr);
          }
        }
      }

      // Finalize: append assistant message to the thread.
      const assistantMsg: ChatMessage = {
        id: genId(),
        role: "assistant",
        content: assistantText || "(empty response)",
        timestamp: nowIso(),
        searchQueries: queries.length > 0 ? queries : undefined,
        citations: citations.length > 0 ? citations : undefined,
      };
      const finalThread: ChatThreadData = {
        ...updatedThread,
        messages: [...updatedThread.messages, assistantMsg],
        updatedAt: nowIso(),
      };
      setActiveThread(finalThread);
      setStreamingText("");
      setStreamingSearchEvents([]);

      // Persist + (if first message) generate a title.
      await persistThread(finalThread);
      if (isFirstMessage) {
        try {
          const titleRes = await fetch("/api/chat/title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ firstUserMessage: text }),
          });
          const { title } = await titleRes.json();
          if (title && typeof title === "string") {
            const titled: ChatThreadData = { ...finalThread, title };
            setActiveThread(titled);
            await persistThread(titled);
          }
        } catch (e) {
          console.error("Failed to generate title:", e);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStreamingText("");
    } finally {
      setIsStreaming(false);
      textareaRef.current?.focus();
    }
  }, [activeThread, contextEnabled, input, isStreaming, persistThread]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }, [send]);

  const visibleMessages = activeThread?.messages ?? [];

  // Auto-grow textarea height.
  const onInputChange = (v: string) => {
    setInput(v);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  const emptyStateSuggestions = useMemo(
    () => [
      "Summarize today's morning brief and tell me where we sit on hedging.",
      "What's my biggest sector overweight right now?",
      "Find me the latest news on NVDA and how it impacts our position.",
      "Walk me through the case for trimming any of my current Portfolio holdings.",
    ],
    [],
  );

  return (
    <div className="relative flex h-[calc(100vh-48px)] gap-3.5 overflow-hidden p-4 md:p-5">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Thread sidebar — a 240px panel column; drawer on mobile, static on md+ */}
      <aside
        className={`panel fixed inset-y-0 left-0 z-40 flex w-[240px] shrink-0 flex-col rounded-none transition-transform duration-200 md:static md:translate-x-0 md:rounded-card ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="panel-h">
          <span className="t">Threads</span>
          {threads.length > 0 && <span className="m">{threads.length}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => {
                newThread();
                setSidebarOpen(false);
              }}
              className="flex h-7 items-center gap-1 rounded-control bg-ink pl-2 pr-2.5 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2"
            >
              <AppIcon name="plus" size={13} strokeWidth={2.25} />
              New
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink md:hidden"
              aria-label="Close threads"
            >
              <AppIcon name="x" size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {threads.length === 0 && (
            <p className="px-3.5 py-6 text-center text-[12px] text-ink-3">No conversations yet.</p>
          )}
          {threads.map((t) => {
            const isActive = t.id === activeThreadId;
            const isRenaming = renamingId === t.id;
            return (
              <div
                key={t.id}
                title={`${t.messageCount} msg · ${formatTime(t.updatedAt)}`}
                className={`group flex h-[34px] items-center gap-2 px-3 text-[12.5px] ${
                  isRenaming ? "" : "cursor-pointer"
                } ${isActive ? "bg-accent-soft text-accent-ink" : "text-ink hover:bg-surface-hover"}`}
                onClick={() => {
                  if (isRenaming) return;
                  setActiveThreadId(t.id);
                  setSidebarOpen(false);
                }}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    className="h-6 w-full rounded-control border border-accent-border bg-surface px-1.5 text-[12.5px] text-ink outline-none"
                    maxLength={80}
                  />
                ) : (
                  <>
                    <span className={`min-w-0 flex-1 truncate ${isActive ? "font-medium" : ""}`}>{t.title}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-3 md:group-hover:hidden">{t.messageCount}</span>
                    <span className="hidden shrink-0 items-center gap-0.5 md:group-hover:flex">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          beginRename(t.id, t.title);
                        }}
                        className="grid h-6 w-6 place-items-center rounded-control text-ink-3 hover:bg-surface hover:text-ink"
                        title="Rename"
                        aria-label="Rename"
                      >
                        <AppIcon name="edit" size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteThread(t.id);
                        }}
                        className="grid h-6 w-6 place-items-center rounded-control text-ink-3 hover:bg-surface hover:text-neg"
                        title="Delete"
                        aria-label="Delete"
                      >
                        <AppIcon name="trash" size={13} />
                      </button>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <section className="panel flex min-w-0 flex-1 flex-col">
        {/* Header: thread title · model meta · Context seg */}
        <div className="panel-h">
          <button
            onClick={() => setSidebarOpen(true)}
            className="-ml-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink md:hidden"
            aria-label="Open threads"
          >
            <AppIcon name="menu" size={15} />
          </button>
          <span className="t truncate">{activeThread?.title ?? "Chat"}</span>
          <span className="m hidden truncate sm:inline">Sonnet 4.6 · web search</span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden text-[11px] text-ink-3 sm:inline">Context</span>
            <div className="seg" role="group" aria-label="Portfolio context">
              <button type="button" className={contextEnabled ? "on" : ""} onClick={() => setContextEnabled(true)}>On</button>
              <button type="button" className={!contextEnabled ? "on" : ""} onClick={() => setContextEnabled(false)}>Off</button>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-4 sm:px-5">
          {visibleMessages.length === 0 && !isStreaming && (
            <div className="mx-auto max-w-2xl pt-8">
              <div className="text-[13px] font-semibold text-ink">Ask anything about the book or the market</div>
              <p className="mt-1 text-[12.5px] leading-[1.5] text-ink-2">
                The latest brief, holdings, market regime and PIM models are in context. Fresh data is pulled from the web when needed.
              </p>
              <div className="mt-4 flex flex-col items-start gap-2">
                {emptyStateSuggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput(s);
                      textareaRef.current?.focus();
                    }}
                    className="inline-flex min-h-7 items-center rounded-control border border-line bg-surface px-2.5 py-1 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {visibleMessages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}

            {isStreaming && (
              <div className="flex flex-col items-start gap-2">
                {streamingSearchEvents.length > 0 && (
                  <div className="flex flex-col gap-1 text-[12px] text-ink-2">
                    {streamingSearchEvents.map((e, idx) =>
                      e.type === "query" ? (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="dot bg-warn" />
                          <span>Searching</span>
                          <span className="text-ink-3">{e.text}</span>
                        </div>
                      ) : (
                        <div key={idx} className="flex items-center gap-2 pl-4">
                          <span className="dot bg-ink-faint" />
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">
                            {e.text}
                          </a>
                        </div>
                      ),
                    )}
                  </div>
                )}
                {streamingText && (
                  <div className="max-w-full break-words rounded-card border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink sm:max-w-2xl">
                    {renderMarkdown(streamingText)}
                    <span className="ml-0.5 inline-block h-3.5 w-[6px] animate-pulse bg-ink-3 align-middle" />
                  </div>
                )}
                {!streamingText && streamingSearchEvents.length === 0 && (
                  <div className="flex items-center gap-2 text-[12px] text-ink-3">
                    <span className="dot animate-pulse bg-accent" />
                    Thinking
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-[12.5px] text-neg">
                <span className="dot mt-[6px] bg-neg" />
                <span><span className="font-medium">Error</span> · {error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-line-soft px-3.5 py-3 sm:px-5">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isStreaming ? "Streaming response" : "Ask anything"}
                disabled={isStreaming}
                rows={1}
                className="min-h-7 flex-1 resize-none rounded-control border border-line bg-surface px-2.5 py-1 text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border disabled:opacity-50"
              />
              <button
                onClick={send}
                disabled={isStreaming || !input.trim()}
                className="h-7 shrink-0 rounded-control bg-ink px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-3">
              Context: brief, holdings, market regime, PIM models · web search on demand · Enter to send, Shift+Enter for a newline
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-full whitespace-pre-wrap break-words rounded-card border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink sm:max-w-2xl">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {message.searchQueries && message.searchQueries.length > 0 && (
        <div className="flex max-w-full flex-col gap-1 text-[12px] text-ink-2 sm:max-w-2xl">
          {message.searchQueries.map((q, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="dot bg-warn" />
              <span>Searched</span>
              <span className="truncate text-ink-3">{q}</span>
            </div>
          ))}
        </div>
      )}
      <div className="max-w-full break-words rounded-card border border-line bg-surface px-3.5 py-2.5 text-[13px] leading-[1.5] text-ink sm:max-w-2xl">
        {renderMarkdown(message.content)}
      </div>
      {message.citations && message.citations.length > 0 && (
        <div className="flex max-w-full flex-col gap-1 text-[12px] sm:max-w-2xl">
          <div className="text-[11px] text-ink-3">Sources</div>
          {message.citations.map((c, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2">
              <span className="dot bg-ink-faint" />
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">
                {c.title ?? c.url}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
