"use client";

/**
 * Redesign › Section inventory — the first deliverable for the team's
 * 4 PM sessions: every screen, what it shows, where the data comes from,
 * how often it refreshes, whether it is fact or AI opinion, and a starting
 * suggestion. Static content (inventory-data.ts); reads and writes nothing.
 */

import React, { useState } from "react";
import Link from "next/link";
import { AI_CALLS, AUTO_FETCHED_NOTE, DUPLICATES, EMAILS, FOUND_WRONG, MANUAL_INPUTS, SCHEDULE, SCREENS, type Kind, type Screen, type Suggestion } from "./inventory-data";
import { Bullets, Card, Figure, More, Page, Table, Tag, TD } from "./ui";

const KIND_TAG: Record<Kind, "green" | "blue" | "red" | "yellow"> = { Fact: "green", Rule: "blue", "AI opinion": "red", Mixed: "yellow" };
const SUG_TAG: Record<Suggestion, "green" | "blue" | "neutral" | "red" | "yellow"> = { Keep: "green", Simplify: "blue", "Move to detail": "neutral", "Candidate to cut": "red", Merge: "yellow" };
const AREAS: Screen["area"][] = ["Today", "Portfolio", "Ideas", "Research", "System"];

function ScreenRow({ s }: { s: Screen }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td className={TD}>
          <Link href={s.href} className="font-bold !text-ink hover:underline">{s.name}</Link>
          <div className="max-w-[420px] text-[13.5px] leading-snug text-ink-2">{s.shows}</div>
        </td>
        <td className={TD}><Tag kind={KIND_TAG[s.kind]}>{s.kind}</Tag></td>
        <td className={`${TD} text-[13.5px] text-ink-2`}>{s.input}</td>
        <td className={TD}><Tag kind={SUG_TAG[s.suggestion]}>{s.suggestion}</Tag></td>
        <td className={`${TD} whitespace-nowrap text-right text-[14px]`}>
          {s.option && <Link href={s.option} className="mr-4 font-semibold !text-accent underline">See options</Link>}
          <button type="button" onClick={() => setOpen(!open)} className="font-semibold text-accent underline">{open ? "Less" : "Detail"}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="border-b border-line-soft bg-surface-2 px-5 py-3">
            <Bullets
              items={[
                <><span className="font-semibold">Data from:</span> {s.sources}</>,
                <><span className="font-semibold">Refreshes:</span> {s.refresh}</>,
                <><span className="font-semibold">Note:</span> {s.note}</>,
              ]}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function Inventory() {
  const count = (k: Suggestion) => SCREENS.filter((s) => s.suggestion === k).length;
  return (
    <Page title="Section inventory" lede="Every screen, what it shows, and a starting suggestion. The team decides.">
      <Card>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-5">
          <Figure label="Screens today" value={SCREENS.length} />
          <Figure label="Keep" value={count("Keep")} valueClass="text-pos" />
          <Figure label="Simplify or merge" value={count("Simplify") + count("Merge")} />
          <Figure label="Move to a detail view" value={count("Move to detail")} />
          <Figure label="Candidates to cut" value={count("Candidate to cut")} valueClass="text-neg" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
          <Tag kind="green">Fact</Tag> data, or arithmetic on data
          <Tag kind="blue">Rule</Tag> a label set by a fixed threshold
          <Tag kind="red">AI opinion</Tag> text or a call written by AI
          <Tag kind="yellow">Mixed</Tag> both on one screen
        </div>
      </Card>

      <Card title="Session schedule" sub="one hour a day, 4:00–5:00 pm" pad={false}>
        <Table head={[{ label: "Day" }, { label: "Topic" }, { label: "Decide" }, { label: "Open" }]} minWidth={760}>
          {SCHEDULE.map((d) => (
            <tr key={d.day}>
              <td className={`${TD} whitespace-nowrap font-bold`}>{d.day}</td>
              <td className={`${TD} font-semibold`}>{d.topic}</td>
              <td className={`${TD} max-w-[340px] text-[14px] text-ink-2`}>{d.bring}</td>
              <td className={`${TD} text-[14px]`}>
                <div className="flex flex-col gap-1">
                  {d.links.map((l) => <Link key={l.href} href={l.href} className="font-semibold !text-accent underline">{l.label}</Link>)}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {AREAS.map((a) => {
        const list = SCREENS.filter((s) => s.area === a);
        return (
          <Card key={a} title={a} sub={`${list.length} screens`} pad={false}>
            <Table head={[{ label: "Screen and what it shows" }, { label: "Fact or opinion" }, { label: "Input" }, { label: "Suggestion" }, { label: "" }]} minWidth={860}>
              {list.map((s) => <ScreenRow key={s.name} s={s} />)}
            </Table>
          </Card>
        );
      })}

      <Card title="Duplicates to resolve" pad={false}>
        <Table head={[{ label: "What" }, { label: "Why it is a duplicate" }, { label: "Proposal" }]} minWidth={820}>
          {DUPLICATES.map((d) => (
            <tr key={d.what}>
              <td className={`${TD} font-bold`}>{d.what}</td>
              <td className={`${TD} max-w-[340px] text-[14px] text-ink-2`}>{d.why}</td>
              <td className={`${TD} max-w-[340px] text-[14px]`}>
                {d.proposal}
                {d.option && <> <Link href={d.option} className="font-semibold !text-accent underline">See options</Link></>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Things found that look wrong" sub="worth fixing whatever the design">
        <Bullets items={FOUND_WRONG} />
      </Card>

      <Card title="Reference lists" pad={false}>
        <More prefKey="redesign.inventory.calls" label="every place a label, call or recommendation is shown" count={AI_CALLS.length}>
          <Bullets items={AI_CALLS.map((c) => <><span className="font-semibold">{c.where}:</span> {c.what}</>)} />
        </More>
        <More prefKey="redesign.inventory.manual" label="everything typed in by hand" count={MANUAL_INPUTS.length}>
          <Bullets items={MANUAL_INPUTS.map((m) => <><span className="font-semibold">{m.what}</span> — {m.where}. {m.note}</>)} />
          <p className="mt-3 text-[14.5px] text-ink-2">{AUTO_FETCHED_NOTE}</p>
        </More>
        <More prefKey="redesign.inventory.emails" label="every automatic email" count={EMAILS.length}>
          <Bullets items={EMAILS.map((e) => <><span className="font-semibold">{e.name}:</span> {e.when}{e.note ? ` · ${e.note}` : ""}</>)} />
        </More>
      </Card>
    </Page>
  );
}
