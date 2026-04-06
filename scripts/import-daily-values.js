#!/usr/bin/env node
/**
 * Converts daily value XLSX files into JSON and POSTs them to the Appendix API.
 *
 * Usage:
 *   node scripts/import-daily-values.js <profile> <xlsx-path> [base-url]
 *
 * Examples:
 *   node scripts/import-daily-values.js allEquity "./All-Equity Daily Value.xlsx"
 *   node scripts/import-daily-values.js growth "./Growth Daily Values.xlsx"
 *   node scripts/import-daily-values.js balanced "./Balanced Daily Values.xlsx" http://localhost:3000
 *
 * Or import all at once:
 *   node scripts/import-daily-values.js all
 *   (reads allEquity.xlsx, growth.xlsx, balanced.xlsx, alpha.xlsx from current dir)
 */

const XLSX = require("xlsx");
const path = require("path");

const BASE_URL = process.argv[4] || process.env.BASE_URL || "http://localhost:3000";

function excelDateToISO(serial) {
  // Excel serial date → JS Date
  const epoch = new Date(1899, 11, 30); // Dec 30, 1899
  const d = new Date(epoch.getTime() + serial * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseSheet(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  console.log(`  Loaded ${rows.length} rows from "${wb.SheetNames[0]}"`);
  if (rows.length > 0) {
    console.log(`  Columns: ${Object.keys(rows[0]).join(", ")}`);
    console.log(`  First row:`, JSON.stringify(rows[0]));
  }

  const entries = [];
  let prevValue = null;

  for (const row of rows) {
    // Try to find date column
    let dateStr = null;
    const dateCol = Object.keys(row).find(
      (k) => k.toLowerCase().includes("date") || k.toLowerCase() === "day"
    ) || Object.keys(row)[0];

    const rawDate = row[dateCol];
    if (typeof rawDate === "number") {
      dateStr = excelDateToISO(rawDate);
    } else if (typeof rawDate === "string") {
      // Try parsing various formats
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        dateStr = `${y}-${m}-${day}`;
      }
    }

    if (!dateStr) continue;

    // Try to find value column
    const valueCol = Object.keys(row).find(
      (k) =>
        k.toLowerCase().includes("value") ||
        k.toLowerCase().includes("daily value") ||
        k.toLowerCase().includes("index") ||
        k.toLowerCase().includes("nav")
    ) || Object.keys(row)[1];

    const value = parseFloat(row[valueCol]);
    if (isNaN(value)) continue;

    // Compute daily return
    let dailyReturn = 0;
    if (prevValue != null && prevValue !== 0) {
      dailyReturn = parseFloat((((value - prevValue) / prevValue) * 100).toFixed(4));
    }
    prevValue = value;

    entries.push({
      date: dateStr,
      value: parseFloat(value.toFixed(4)),
      dailyReturn,
    });
  }

  return entries;
}

async function importProfile(profile, filePath) {
  console.log(`\nImporting ${profile} from: ${filePath}`);

  const entries = parseSheet(filePath);
  console.log(`  Parsed ${entries.length} daily values`);
  console.log(`  Date range: ${entries[0]?.date} to ${entries[entries.length - 1]?.date}`);
  console.log(`  Start value: ${entries[0]?.value}, End value: ${entries[entries.length - 1]?.value}`);

  // POST to appendix API
  const url = `${BASE_URL}/api/kv/appendix-daily-values`;
  console.log(`  POSTing to ${url}...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, entries, seed: true }),
  });

  const result = await res.json();
  console.log(`  Result:`, JSON.stringify(result));

  // Also save JSON file for backup
  const outPath = path.join(__dirname, `${profile}-daily-values.json`);
  require("fs").writeFileSync(outPath, JSON.stringify(entries, null, 0));
  console.log(`  Backup saved to: ${outPath}`);

  return result;
}

async function main() {
  const profile = process.argv[2];
  const filePath = process.argv[3];

  if (!profile) {
    console.log("Usage: node scripts/import-daily-values.js <profile> <xlsx-path> [base-url]");
    console.log("Profiles: balanced, growth, allEquity, alpha");
    process.exit(1);
  }

  await importProfile(profile, filePath);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
