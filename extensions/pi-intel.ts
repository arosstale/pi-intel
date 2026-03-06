/**
 * pi-intel — Competitor Intelligence & Market Tracking
 * Monitor GitHub repos, npm packages, track trends, generate digests.
 *
 * /intel track <repo-or-pkg>  → add to watchlist
 * /intel list                 → show watchlist
 * /intel scan [id|all]        → fetch latest data
 * /intel compare <a> <b>      → side-by-side
 * /intel trends <pkg>         → npm download trends
 * /intel digest               → weekly change report
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const SAVE_DIR = join(homedir(), ".pi", "intel");
const DATA_FILE = join(SAVE_DIR, "watchlist.json");
const RST = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m";

interface Snapshot {
  date: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  downloads?: number;
  version?: string;
  lastPush?: string;
}

interface TrackedItem {
  id: string;
  type: "github" | "npm";
  name: string;
  url: string;
  tag: string;
  description: string;
  snapshots: Snapshot[];
  addedAt: string;
}

function loadWatchlist(): TrackedItem[] {
  mkdirSync(SAVE_DIR, { recursive: true });
  try { return JSON.parse(readFileSync(DATA_FILE, "utf-8")); } catch { return []; }
}

function saveWatchlist(items: TrackedItem[]) {
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

function nextId(items: TrackedItem[]): string {
  const max = items.reduce((m, i) => Math.max(m, parseInt(i.id.replace("intel-", "")) || 0), 0);
  return `intel-${String(max + 1).padStart(3, "0")}`;
}

function curlJson(url: string): any {
  try {
    const out = execSync(`curl -sL "${url}"`, { encoding: "utf-8", timeout: 15000 });
    return JSON.parse(out);
  } catch { return null; }
}

function fetchGithubData(owner: string, repo: string): Snapshot & { description?: string } {
  const data = curlJson(`https://api.github.com/repos/${owner}/${repo}`);
  if (!data || data.message) return { date: new Date().toISOString() };
  return {
    date: new Date().toISOString(),
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    lastPush: data.pushed_at,
    description: data.description,
  };
}

function fetchNpmData(pkg: string): Snapshot & { description?: string } {
  const data = curlJson(`https://registry.npmjs.org/${pkg}`);
  if (!data || data.error) return { date: new Date().toISOString() };

  const latest = data["dist-tags"]?.latest || "";
  const downloads = curlJson(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);

  return {
    date: new Date().toISOString(),
    version: latest,
    downloads: downloads?.downloads || 0,
    description: data.description,
  };
}

function delta(curr: number | undefined, prev: number | undefined): string {
  if (curr === undefined || prev === undefined) return "";
  const diff = curr - prev;
  if (diff === 0) return `${D}→${RST}`;
  return diff > 0 ? `${GREEN}+${diff}${RST}` : `${RED}${diff}${RST}`;
}

function trendArrow(snapshots: Snapshot[], field: "stars" | "downloads"): string {
  if (snapshots.length < 2) return "—";
  const curr = snapshots[snapshots.length - 1][field];
  const prev = snapshots[snapshots.length - 2][field];
  if (curr === undefined || prev === undefined) return "—";
  if (curr > prev) return `${GREEN}▲${RST}`;
  if (curr < prev) return `${RED}▼${RST}`;
  return `${D}▶${RST}`;
}

function parseTarget(target: string): { type: "github" | "npm"; name: string; owner?: string; repo?: string } {
  // GitHub: owner/repo or https://github.com/owner/repo
  const ghMatch = target.match(/(?:github\.com\/)?([^\/]+)\/([^\/\s]+)/);
  if (ghMatch && !target.startsWith("@")) {
    return { type: "github", name: `${ghMatch[1]}/${ghMatch[2]}`, owner: ghMatch[1], repo: ghMatch[2] };
  }
  // npm: @scope/pkg or pkg
  return { type: "npm", name: target };
}

export default function piIntel(pi: ExtensionAPI) {
  pi.registerCommand("intel", {
    description: "Competitor intel. /intel [track|list|scan|compare|trends|digest|untrack]",
    execute: async (ctx, args) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || "help";

      switch (sub) {
        case "track": {
          const target = parts.slice(1).filter(p => !p.startsWith("--")).join(" ");
          const tag = parts.find(p => p.startsWith("--tag="))?.split("=")[1] || "competitor";
          if (!target) { ctx.ui.notify("Usage: /intel track <github-owner/repo or npm-package> [--tag=X]", "error"); return; }

          const parsed = parseTarget(target);
          const items = loadWatchlist();

          if (items.some(i => i.name === parsed.name)) {
            ctx.ui.notify(`Already tracking: ${parsed.name}`, "error"); return;
          }

          // Fetch initial data
          let snapshot: Snapshot & { description?: string };
          if (parsed.type === "github") {
            snapshot = fetchGithubData(parsed.owner!, parsed.repo!);
          } else {
            snapshot = fetchNpmData(parsed.name);
          }

          const item: TrackedItem = {
            id: nextId(items), type: parsed.type, name: parsed.name,
            url: parsed.type === "github" ? `https://github.com/${parsed.name}` : `https://npmjs.com/package/${parsed.name}`,
            tag, description: (snapshot as any).description || "",
            snapshots: [snapshot], addedAt: new Date().toISOString(),
          };

          items.push(item);
          saveWatchlist(items);

          let msg = `${GREEN}✓${RST} Tracking ${B}${item.name}${RST} (${item.type}, ${item.tag})`;
          if (snapshot.stars !== undefined) msg += `\n  ⭐ ${snapshot.stars} stars`;
          if (snapshot.downloads !== undefined) msg += `\n  📥 ${snapshot.downloads} downloads/week`;
          if (snapshot.version) msg += `\n  📦 v${snapshot.version}`;
          ctx.ui.notify(msg, "info");
          break;
        }

        case "list": case "ls": {
          const items = loadWatchlist();
          if (items.length === 0) { ctx.ui.notify("Watchlist empty. Use /intel track <repo-or-pkg>", "info"); return; }
          let out = `${B}${CYAN}Intel Watchlist${RST} (${items.length})\n\n`;
          out += `  ${"ID".padEnd(10)} ${"Name".padEnd(30)} ${"Type".padEnd(7)} ${"Tag".padEnd(12)} Metric\n`;
          out += `  ${D}${"─".repeat(75)}${RST}\n`;
          for (const item of items) {
            const last = item.snapshots[item.snapshots.length - 1];
            const metric = item.type === "github"
              ? `⭐ ${last?.stars ?? "—"} ${trendArrow(item.snapshots, "stars")}`
              : `📥 ${last?.downloads ?? "—"}/wk ${trendArrow(item.snapshots, "downloads")}`;
            out += `  ${D}${item.id.padEnd(10)}${RST} ${item.name.padEnd(30).slice(0, 30)} ${D}${item.type.padEnd(7)}${RST} ${item.tag.padEnd(12)} ${metric}\n`;
          }
          ctx.ui.notify(out, "info");
          break;
        }

        case "scan": {
          const target = parts[1] || "all";
          const items = loadWatchlist();
          const toScan = target === "all" ? items : items.filter(i => i.id === target || i.name.includes(target));
          if (toScan.length === 0) { ctx.ui.notify("Nothing to scan.", "error"); return; }

          let out = `${B}${CYAN}Scanning ${toScan.length} items...${RST}\n\n`;
          for (const item of toScan) {
            const prev = item.snapshots[item.snapshots.length - 1];
            let snap: Snapshot;
            if (item.type === "github") {
              const [owner, repo] = item.name.split("/");
              snap = fetchGithubData(owner, repo);
            } else {
              snap = fetchNpmData(item.name);
            }
            item.snapshots.push(snap);

            out += `  ${B}${item.name}${RST}`;
            if (snap.stars !== undefined) out += ` ⭐ ${snap.stars} ${delta(snap.stars, prev?.stars)}`;
            if (snap.downloads !== undefined) out += ` 📥 ${snap.downloads}/wk ${delta(snap.downloads, prev?.downloads)}`;
            if (snap.version) out += ` v${snap.version}`;
            out += "\n";
          }

          saveWatchlist(items);
          ctx.ui.notify(out, "info");
          break;
        }

        case "compare": {
          const items = loadWatchlist();
          const a = items.find(i => i.id === parts[1] || i.name.includes(parts[1] || ""));
          const b = items.find(i => i.id === parts[2] || i.name.includes(parts[2] || ""));
          if (!a || !b) { ctx.ui.notify("Usage: /intel compare <id1> <id2>", "error"); return; }

          const snapA = a.snapshots[a.snapshots.length - 1];
          const snapB = b.snapshots[b.snapshots.length - 1];

          let out = `${B}${CYAN}Comparison${RST}\n\n`;
          out += `  ${"".padEnd(15)} ${a.name.padEnd(25).slice(0, 25)} ${b.name.padEnd(25).slice(0, 25)}\n`;
          out += `  ${D}${"─".repeat(65)}${RST}\n`;
          out += `  ${"Type".padEnd(15)} ${a.type.padEnd(25)} ${b.type.padEnd(25)}\n`;
          if (snapA.stars !== undefined || snapB.stars !== undefined)
            out += `  ${"Stars".padEnd(15)} ${String(snapA.stars ?? "—").padEnd(25)} ${String(snapB.stars ?? "—").padEnd(25)}\n`;
          if (snapA.downloads !== undefined || snapB.downloads !== undefined)
            out += `  ${"Downloads/wk".padEnd(15)} ${String(snapA.downloads ?? "—").padEnd(25)} ${String(snapB.downloads ?? "—").padEnd(25)}\n`;
          if (snapA.version || snapB.version)
            out += `  ${"Version".padEnd(15)} ${(snapA.version || "—").padEnd(25)} ${(snapB.version || "—").padEnd(25)}\n`;
          if (snapA.openIssues !== undefined || snapB.openIssues !== undefined)
            out += `  ${"Open issues".padEnd(15)} ${String(snapA.openIssues ?? "—").padEnd(25)} ${String(snapB.openIssues ?? "—").padEnd(25)}\n`;

          ctx.ui.notify(out, "info");
          break;
        }

        case "trends": {
          const pkg = parts[1];
          if (!pkg) { ctx.ui.notify("Usage: /intel trends <npm-package>", "error"); return; }
          const data = curlJson(`https://api.npmjs.org/downloads/range/last-month/${pkg}`);
          if (!data || data.error) { ctx.ui.notify(`Could not fetch trends for ${pkg}`, "error"); return; }

          // Aggregate by week
          const downloads: { week: string; total: number }[] = [];
          let weekTotal = 0; let weekStart = "";
          for (let i = 0; i < data.downloads.length; i++) {
            const d = data.downloads[i];
            if (i % 7 === 0) { if (weekStart) downloads.push({ week: weekStart, total: weekTotal }); weekStart = d.day; weekTotal = 0; }
            weekTotal += d.downloads;
          }
          if (weekStart) downloads.push({ week: weekStart, total: weekTotal });

          const max = Math.max(...downloads.map(d => d.total), 1);
          let out = `${B}${CYAN}${pkg}${RST} — weekly downloads\n\n`;
          for (const w of downloads) {
            const barLen = Math.round((w.total / max) * 30);
            out += `  ${D}${w.week}${RST} ${GREEN}${"█".repeat(barLen)}${RST} ${w.total.toLocaleString()}\n`;
          }
          ctx.ui.notify(out, "info");
          break;
        }

        case "digest": {
          const items = loadWatchlist();
          if (items.length === 0) { ctx.ui.notify("Watchlist empty.", "info"); return; }

          let out = `${B}${CYAN}Weekly Intel Digest${RST}\n\n`;
          let hasChanges = false;

          for (const item of items) {
            if (item.snapshots.length < 2) continue;
            const curr = item.snapshots[item.snapshots.length - 1];
            const prev = item.snapshots[item.snapshots.length - 2];
            const changes: string[] = [];

            if (curr.stars !== undefined && prev.stars !== undefined && curr.stars !== prev.stars)
              changes.push(`stars ${delta(curr.stars, prev.stars)}`);
            if (curr.downloads !== undefined && prev.downloads !== undefined && curr.downloads !== prev.downloads)
              changes.push(`downloads ${delta(curr.downloads, prev.downloads)}`);
            if (curr.version && prev.version && curr.version !== prev.version)
              changes.push(`${GREEN}new release: v${curr.version}${RST}`);
            if (curr.openIssues !== undefined && prev.openIssues !== undefined && Math.abs(curr.openIssues - prev.openIssues) > 5)
              changes.push(`issues ${delta(curr.openIssues, prev.openIssues)}`);

            if (changes.length > 0) {
              hasChanges = true;
              out += `  ${B}${item.name}${RST} (${item.tag})\n`;
              for (const c of changes) out += `    • ${c}\n`;
              out += "\n";
            }
          }

          if (!hasChanges) out += `  ${D}No significant changes detected. Run /intel scan all to refresh data.${RST}`;
          ctx.ui.notify(out, "info");
          break;
        }

        case "untrack": case "remove": {
          const id = parts[1];
          if (!id) { ctx.ui.notify("Usage: /intel untrack <id>", "error"); return; }
          const items = loadWatchlist();
          const idx = items.findIndex(i => i.id === id);
          if (idx === -1) { ctx.ui.notify(`Not found: ${id}`, "error"); return; }
          const removed = items.splice(idx, 1)[0];
          saveWatchlist(items);
          ctx.ui.notify(`${RED}✗${RST} Removed ${B}${removed.name}${RST}`, "info");
          break;
        }

        default: {
          ctx.ui.notify([
            `${B}${CYAN}🔍 Intel — Competitor Tracking${RST}`,
            "",
            `  /intel track <repo-or-pkg> [--tag=X]  — add to watchlist`,
            `  /intel list                            — show watchlist`,
            `  /intel scan [id|all]                   — fetch latest data`,
            `  /intel compare <a> <b>                 — side-by-side`,
            `  /intel trends <npm-pkg>                — download chart`,
            `  /intel digest                          — weekly changes`,
            `  /intel untrack <id>                    — remove`,
          ].join("\n"), "info");
        }
      }
    },
  });

  pi.registerTool("intel_scan", {
    description: "Scan tracked competitors for latest data (stars, downloads, versions, activity)",
    parameters: Type.Object({ target: Type.Optional(Type.String({ description: "Item ID or 'all'" })) }),
    execute: async (p) => {
      const items = loadWatchlist();
      const toScan = (p.target && p.target !== "all") ? items.filter(i => i.id === p.target || i.name.includes(p.target)) : items;
      const results: any[] = [];
      for (const item of toScan) {
        let snap: Snapshot;
        if (item.type === "github") {
          const [owner, repo] = item.name.split("/");
          snap = fetchGithubData(owner, repo);
        } else {
          snap = fetchNpmData(item.name);
        }
        item.snapshots.push(snap);
        results.push({ name: item.name, ...snap });
      }
      saveWatchlist(items);
      return results;
    },
  });

  pi.registerTool("intel_compare", {
    description: "Compare two tracked items side-by-side",
    parameters: Type.Object({ a: Type.String(), b: Type.String() }),
    execute: async (p) => {
      const items = loadWatchlist();
      const a = items.find(i => i.id === p.a || i.name.includes(p.a));
      const b = items.find(i => i.id === p.b || i.name.includes(p.b));
      if (!a || !b) return { error: "Items not found" };
      return {
        [a.name]: a.snapshots[a.snapshots.length - 1],
        [b.name]: b.snapshots[b.snapshots.length - 1],
      };
    },
  });

  pi.registerTool("intel_trends", {
    description: "Get npm download trends for a package (last 4 weeks)",
    parameters: Type.Object({ package: Type.String() }),
    execute: async (p) => {
      const data = curlJson(`https://api.npmjs.org/downloads/range/last-month/${p.package}`);
      if (!data || data.error) return { error: "Could not fetch" };
      return { package: p.package, totalDownloads: data.downloads.reduce((s: number, d: any) => s + d.downloads, 0), days: data.downloads.length };
    },
  });
}
