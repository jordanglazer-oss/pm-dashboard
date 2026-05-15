"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatThreadData } from "@/app/api/kv/chat-threads/[id]/route";
import type { ChatThreadManifestEntry } from "@/app/api/kv/chat-threads/route";

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
          <div key={key++} className="overflow-x-auto -mx-1 my-2">
            <table className="text-xs border-collapse w-full">
              <thead>
                <tr className="border-b border-slate-300">
                  {headerCells.map((c, ci) => (
                    <th key={ci} className="text-left font-semibold px-2 py-1.5 text-slate-700">
                      {renderInline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, ri) => (
                  <tr key={ri} className="border-b border-slate-100 last:border-b-0">
                    {row.map((c, ci) => (
                      <td key={ci} className="px-2 py-1.5 align-top text-slate-700">
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
        <p key={key++} className="font-bold text-slate-900 mt-3 first:mt-0 mb-1.5">
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
        <ul key={key++} className="list-disc pl-5 space-y-1 mb-3 last:mb-0">
          {items.map((it, idx) => (
            <li key={idx} className="leading-relaxed">{renderInline(it)}</li>
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
        <ol key={key++} className="list-decimal pl-5 space-y-1 mb-3 last:mb-0">
          {items.map((it, idx) => (
            <li key={idx} className="leading-relaxed">{renderInline(it)}</li>
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
      <p key={key++} className="leading-relaxed mb-3 last:mb-0">
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
    if (t.type === "code") return <code key={idx} className="rounded bg-slate-100 px-1 py-0.5 text-[0.85em] font-mono">{t.content}</code>;
    if (t.type === "link") return <a key={idx} href={t.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800">{t.content}</a>;
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
    <div className="relative flex h-[calc(100vh-46px)] bg-slate-50 overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/30 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Sidebar — drawer on mobile, static on md+ */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-40 w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col
          transform transition-transform duration-200
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
        `}
      >
        <div className="p-3 border-b border-slate-200 flex items-center gap-2">
          <button
            onClick={() => {
              newThread();
              setSidebarOpen(false);
            }}
            className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            + New chat
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Close sidebar"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <p className="px-4 py-6 text-xs text-slate-400 text-center">No conversations yet. Start a new one above.</p>
          )}
          {threads.map((t) => {
            const isActive = t.id === activeThreadId;
            const isRenaming = renamingId === t.id;
            return (
              <div
                key={t.id}
                className={`group flex items-start gap-1.5 px-3 py-2.5 border-b border-slate-100 ${
                  isRenaming ? "" : "cursor-pointer"
                } ${isActive ? "bg-blue-50" : "hover:bg-slate-50"}`}
                onClick={() => {
                  if (isRenaming) return;
                  setActiveThreadId(t.id);
                  setSidebarOpen(false);
                }}
              >
                <div className="flex-1 min-w-0">
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
                      className="w-full text-sm font-semibold text-slate-900 bg-white border border-blue-400 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-200"
                      maxLength={80}
                    />
                  ) : (
                    <p className={`text-sm truncate ${isActive ? "font-semibold text-blue-900" : "text-slate-700"}`}>{t.title}</p>
                  )}
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {t.messageCount} msg · {formatTime(t.updatedAt)}
                  </p>
                </div>
                {!isRenaming && (
                  <div className="flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        beginRename(t.id, t.title);
                      }}
                      className="text-slate-400 hover:text-blue-600 p-0.5"
                      title="Rename"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteThread(t.id);
                      }}
                      className="text-slate-400 hover:text-red-600 p-0.5"
                      title="Delete"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="px-4 md:px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden shrink-0 rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Open conversations"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900 truncate">{activeThread?.title ?? "Chat"}</h1>
              <p className="text-[11px] text-slate-400 truncate">
                Sonnet 4.6 · web search · {contextEnabled ? "context on" : "context off"}
              </p>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer shrink-0">
            <span className="text-xs font-semibold text-slate-600 hidden sm:inline">Context</span>
            <button
              onClick={() => setContextEnabled((v) => !v)}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                contextEnabled ? "bg-blue-600" : "bg-slate-300"
              }`}
              type="button"
            >
              <span
                className={`absolute top-0.5 ${
                  contextEnabled ? "left-5" : "left-0.5"
                } w-4 h-4 rounded-full bg-white transition-all`}
              />
            </button>
          </label>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-6">
          {visibleMessages.length === 0 && !isStreaming && (
            <div className="max-w-full sm:max-w-2xl mx-auto pt-12">
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Ask anything about your dashboard or the market</h2>
              <p className="text-sm text-slate-500 mb-6">
                I have access to your latest brief, holdings, market regime, and PIM models. I can also pull fresh data
                from the web when needed.
              </p>
              <div className="space-y-2">
                {emptyStateSuggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setInput(s);
                      textareaRef.current?.focus();
                    }}
                    className="block w-full text-left rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 hover:border-blue-400 hover:bg-blue-50 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-w-3xl mx-auto space-y-4">
            {visibleMessages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}

            {isStreaming && (
              <div className="flex flex-col items-start gap-2">
                {streamingSearchEvents.length > 0 && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 space-y-1">
                    {streamingSearchEvents.map((e, idx) =>
                      e.type === "query" ? (
                        <div key={idx} className="flex items-center gap-1.5">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                          <span className="font-semibold">Searching:</span>
                          <span>{e.text}</span>
                        </div>
                      ) : (
                        <div key={idx} className="flex items-center gap-1.5 pl-5">
                          <span className="text-amber-600">·</span>
                          <a href={e.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-amber-900">
                            {e.text}
                          </a>
                        </div>
                      ),
                    )}
                  </div>
                )}
                {streamingText && (
                  <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 max-w-full sm:max-w-2xl text-sm break-words text-slate-900">
                    {renderMarkdown(streamingText)}
                    <span className="inline-block w-2 h-4 bg-blue-500 ml-1 animate-pulse" />
                  </div>
                )}
                {!streamingText && streamingSearchEvents.length === 0 && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    Thinking…
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                <span className="font-semibold">Error:</span> {error}
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-slate-200 bg-white px-3 sm:px-6 py-3">
          <div className="max-w-3xl mx-auto">
            <div className="relative rounded-2xl border border-slate-300 bg-white focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={isStreaming ? "Streaming response…" : "Ask anything (Shift+Enter for newline)…"}
                disabled={isStreaming}
                rows={1}
                className="w-full resize-none rounded-2xl bg-transparent px-4 py-3 pr-14 text-sm text-slate-900 placeholder-slate-400 outline-none disabled:opacity-50"
              />
              <button
                onClick={send}
                disabled={isStreaming || !input.trim()}
                className="absolute right-2 bottom-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
              >
                Send
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 text-center">
              Context: brief, holdings, market regime, PIM models. Web search on demand. ⌘+Enter / Enter to send.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white rounded-2xl px-4 py-3 max-w-full sm:max-w-2xl text-sm break-words whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {message.searchQueries && message.searchQueries.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 space-y-0.5 max-w-full sm:max-w-2xl">
          <div className="font-semibold">Web searches:</div>
          {message.searchQueries.map((q, i) => (
            <div key={i} className="pl-2">· {q}</div>
          ))}
        </div>
      )}
      <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 max-w-full sm:max-w-2xl text-sm break-words text-slate-900">
        {renderMarkdown(message.content)}
      </div>
      {message.citations && message.citations.length > 0 && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-600 max-w-full sm:max-w-2xl">
          <div className="font-semibold mb-1">Sources:</div>
          <ul className="space-y-0.5">
            {message.citations.map((c, i) => (
              <li key={i} className="truncate">
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:text-blue-800">
                  {c.title ?? c.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
