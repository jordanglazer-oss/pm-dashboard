repo: jordanglazer-oss/pm-dashboard
branch: main

## Last sync
date: 2026-07-28T00:04:20Z

### Updated in this project
- Recreated the current Brief page (`/brief`) pixel-faithfully from MorningBrief.tsx.
- Recreated the app shell: Navigation top bar, tab row, keyboard-hint strip.
- Notification bell trigger matched to NotificationTray.tsx (36px, unread badge).
- Added a redesigned Brief page: cockpit band, consolidated macro board, collapsible narrative, mobile-first Daily Input, generation progress checklist.

## Screen map
| Project screen | Repo files |
| --- | --- |
| Brief — Current.dc.html | app/(dashboard)/brief/page.tsx, app/components/MorningBrief.tsx, app/components/Navigation.tsx, app/components/SentimentGauges.tsx, app/components/SignalPill.tsx, app/components/HedgingIndicator.tsx, app/components/NotificationTray.tsx, app/globals.css, app/layout.tsx |
| Brief — Redesign.dc.html | same sources; new layout built on the Precision Light tokens in app/globals.css |
