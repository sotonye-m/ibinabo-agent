/**
 * Storage: Google Sheets (production) or a local JSON file (DB_BACKEND=file, for dev/tests).
 * Every request loads a full snapshot (the data is small), mutates it in memory, and writes back
 * only the tabs it touched.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { google, type sheets_v4 } from "googleapis";
import { HEADERS, NUMERIC, TABS, type Db, type TabName } from "./types.js";

export function emptyDb(): Db {
  return Object.fromEntries(TABS.map((t) => [t, []])) as unknown as Db;
}

const backend = () => (process.env.DB_BACKEND ?? "sheets").toLowerCase();
const FILE = () => process.env.DB_FILE ?? path.join(process.cwd(), "data", "db.json");

let sheetsClient: sheets_v4.Sheets | null = null;
export function sheets(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  if (!email || !key || !process.env.GOOGLE_SHEET_ID) {
    throw new Error("Google Sheets not configured (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY)");
  }
  const auth = new google.auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}
export const sheetId = () => process.env.GOOGLE_SHEET_ID as string;

function coerce(tab: TabName, raw: unknown[][]): any[] {
  const [head, ...rows] = raw;
  if (!head) return [];
  const cols = head.map((h) => String(h));
  return rows
    .filter((r) => r.some((c) => c !== "" && c !== null && c !== undefined))
    .map((r) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = r[i];
        if (NUMERIC.has(c)) o[c] = v === "" || v === undefined || v === null ? 0 : Number(v);
        else if (tab === "Scorecard" && typeof v === "number") o[c] = v;
        else o[c] = v === undefined || v === null ? "" : String(v);
      });
      return o;
    });
}

export async function loadDb(): Promise<Db> {
  if (backend() === "file") {
    try {
      return { ...emptyDb(), ...JSON.parse(await fs.readFile(FILE(), "utf8")) };
    } catch {
      return emptyDb();
    }
  }
  const res = await sheets().spreadsheets.values.batchGet({
    spreadsheetId: sheetId(),
    ranges: TABS.map((t) => `${t}!A1:Z`),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const db = emptyDb() as any;
  (res.data.valueRanges ?? []).forEach((vr, i) => {
    db[TABS[i]] = coerce(TABS[i], (vr.values ?? []) as unknown[][]);
  });
  return db as Db;
}

function toValues(tab: TabName, rows: any[]): (string | number)[][] {
  const head = HEADERS[tab] as string[];
  return [head, ...rows.map((r) => head.map((h) => (r[h] === null || r[h] === undefined ? "" : r[h])))];
}

export async function saveDb(db: Db, tabs: Iterable<TabName>): Promise<void> {
  const list = [...new Set(tabs)];
  if (!list.length) return;
  if (backend() === "file") {
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    await fs.writeFile(FILE(), JSON.stringify(db, null, 1));
    return;
  }
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId(),
    requestBody: {
      valueInputOption: "RAW",
      data: list.map((t) => ({ range: `${t}!A1`, values: toValues(t, db[t] as any[]) })),
    },
  });
}

/** Wipe every tab and write the whole Db (used by the seed). Creates missing tabs. */
export async function replaceAll(db: Db): Promise<void> {
  if (backend() === "file") return saveDb(db, TABS);
  const api = sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: sheetId() });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const add = TABS.filter((t) => !existing.has(t)).map((title) => ({ addSheet: { properties: { title } } }));
  if (add.length) await api.spreadsheets.batchUpdate({ spreadsheetId: sheetId(), requestBody: { requests: add } });
  await api.spreadsheets.values.batchClear({ spreadsheetId: sheetId(), requestBody: { ranges: TABS.map((t) => `${t}!A:Z`) } });
  await saveDb(db, TABS);
}
