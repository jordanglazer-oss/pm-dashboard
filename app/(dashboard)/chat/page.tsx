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

// Render assistant content with **bold**, *italics*, line breaks, and links.
// Intentionally minimal so we don't pull in react-markdown.
function renderMarkdown(text: string): React.ReactNode {
  // Split into paragraphs by blank lines, render line-breaks inside.
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, pIdx) => {
    const lines = para.split("\n");
    return (
      <p key={pIdx} className="mb-3 last:mb-0 leading-relaxed">
        {lines.map((line, lIdx) => (
          <span key={lIdx}>
            {renderInline(line)}
            {lIdx < lines.length - 1 && <br />}
          </span>
        ))}
      </p>
    );
  });
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="flex h-[calc(100vh-58px)] bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="p-3 border-b border-slate-200">
          <button
            onClick={newThread}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            + New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <p className="px-4 py-6 text-xs text-slate-400 text-center">No conversations yet. Start a new one above.</p>
          )}
          {threads.map((t) => {
            const isActive = t.id === activeThreadId;
            return (
              <div
                key={t.id}
                className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-slate-100 ${
                  isActive ? "bg-blue-50" : "hover:bg-slate-50"
                }`}
                onClick={() => setActiveThreadId(t.id)}
              >
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${isActive ? "font-semibold text-blue-900" : "text-slate-700"}`}>{t.title}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {t.messageCount} msg · {formatTime(t.updatedAt)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteThread(t.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 transition-opacity"
                  title="Delete"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-slate-900">{activeThread?.title ?? "Chat"}</h1>
            <p className="text-[11px] text-slate-400">
              Sonnet 4.6 · web search enabled · {contextEnabled ? "dashboard context loaded" : "no dashboard context"}
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs font-semibold text-slate-600">Context</span>
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
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
          {visibleMessages.length === 0 && !isStreaming && (
            <div className="max-w-2xl mx-auto pt-12">
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
                  <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 max-w-2xl text-sm text-slate-900">
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
        <div className="border-t border-slate-200 bg-white px-6 py-3">
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
        <div className="bg-blue-600 text-white rounded-2xl px-4 py-3 max-w-2xl text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {message.searchQueries && message.searchQueries.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-800 space-y-0.5 max-w-2xl">
          <div className="font-semibold">Web searches:</div>
          {message.searchQueries.map((q, i) => (
            <div key={i} className="pl-2">· {q}</div>
          ))}
        </div>
      )}
      <div className="bg-white rounded-2xl border border-slate-200 px-4 py-3 max-w-2xl text-sm text-slate-900">
        {renderMarkdown(message.content)}
      </div>
      {message.citations && message.citations.length > 0 && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-600 max-w-2xl">
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
