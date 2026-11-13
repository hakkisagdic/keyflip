# DESIGN.md — Keyflip Web Panel & Billing UI Design System

## 1. Aesthetic Direction: Terminal-Industrial Precision Telemetry

Keyflip is a developer-first AI credential orchestrator, cost router, and zero-trust proxy gateway. Its web surfaces (`keyflip panel`, `keyflip panel --snapshot`, `keyflip fleet`, and `issuer/` billing/admin console) adhere to a **Terminal-Industrial Precision Telemetry** aesthetic inspired by Linear, Cloudflare Radar, and Grafana Dark:

- **High-signal, zero-ornamentation:** Every card, progress bar, sparkline, and badge represents live operational state (5h/7d token quota, cache hit rate, PII guardrail posture, virtual key spend, license ROI).
- **No AI-SaaS clichés:** No purple-to-cyan gradients, no decorative 3D blobs, no marketing hero banners inside operational views, and no unaligned floating counters.
- **Offline & zero-dependency:** All styles, SVG sparklines, and activity heatmaps are rendered inline without external webfont fetches or CDN scripts.

---

## 2. Color Tokens (Dark Default + Light Adaptive)

| Token | Dark Mode (Default) | Light Mode (`prefers-color-scheme: light`) | Role |
|---|---|---|---|
| `--bg` | `#0f1115` | `#f6f7f9` | Canvas background |
| `--card` | `#1a1d24` | `#ffffff` | Surface / card container |
| `--fg` | `#e6e8ec` | `#1a1d24` | Primary text & active indicators |
| `--muted` | `#8b909a` | `#6b7280` | Secondary labels, timestamps, units |
| `--bar` | `#2a2e37` | `#e5e7eb` | Hairline 1px borders & empty progress tracks |
| `--accent` | `#7aa2f7` | `#2563eb` | Active account/provider border & sparkline stroke |
| `--ok` | `#6ccf8e` | `#16a34a` | Healthy quota (<70%), active license, cache savings |
| `--warn` | `#e0af68` | `#d97706` | Elevated quota (70–89%), grace period, temp boost |
| `--bad` | `#f7768e` | `#dc2626` | Critical quota (>=90%), revoked/expired, blocked leak |

---

## 3. Typography & Numeric Discipline

- **Primary UI Font Stack:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` (`14px/1.5`).
- **Monospace Stack (IDs, CLI commands, hashes):** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`.
- **Mandatory Numeric Alignment (`tabular-nums`):**
  - `font-variant-numeric: tabular-nums` is enforced on `body` and explicitly on `.kpi-val`, `.barlabel`, `.acct`, and table cells so percentages (`5h 40%`, `7d 100%`), currency amounts (`$12.40`, `₺420.00`), and counters never jitter during live refresh.
- **Section Headers (`h2`):** `13px`, uppercase, `letter-spacing: 0.05em`, color `var(--muted)`, `margin: 0 0 10px`.

---

## 4. Component Specifications

### 4.1 Account Quota Cards (`.card`)
- `1px solid var(--bar)` (`var(--accent)` when `.active`), `border-radius: 12px`, `padding: 14px`.
- **Quota Bar (`.bar`):** `6px` height, `border-radius: 4px`, semantic fill (`--ok` < 70%, `--warn` 70–89%, `--bad` >= 90%).
- **Sparkline (`.spark`):** Inline SVG `viewBox="0 0 200 26"`, `stroke-width: 1.5`, `vector-effect: non-scaling-stroke`.

### 4.2 Telemetry KPI Strip (`.kpi-grid` / `.kpi-card`)
- Displays **License & Monthly Value**, **Semantic Cache**, **PII & Secret Guardrail**, and **Virtual Keys (`vk_`)** in structured telemetry cards rather than a single cramped line of text.
- Each `.kpi-card` contains:
  - `.kpi-label` (`11px`, uppercase, `var(--muted)`)
  - `.kpi-val` (`18px`, `font-weight: 600`, `tabular-nums`)
  - `.kpi-sub` (`12px`, `var(--muted)` with semantic badges for trial/grace/guardrail mode)

### 4.3 Activity Heatmap (`.cal`) & Memory Constellation (`.mg`)
- **Activity Heatmap:** 26-week Sunday-aligned UTC grid (`11x11` cells on `13px` pitch, levels `l0`–`l4`). Wrapped in `#activity { overflow-x: auto }` so narrow mobile viewports scroll the SVG internally without overflowing `body`.
- **Memory Constellation:** Circular node-link SVG (`viewBox="0 0 360 320"`, `max-width: 440px`), responsive width (`width: 100%; height: auto`).

---

## 5. Responsive Layout & Viewport Quality Gate

The panel is verified across three canonical viewports with **zero horizontal page overflow (`document.documentElement.scrollWidth <= window.innerWidth`)**:

1. **Mobile (`390×844` — `@media (max-width: 600px)`):**
   - `.grid` and `.kpi-grid` collapse to `grid-template-columns: 1fr`.
   - `header` wraps cleanly (`flex-wrap: wrap; padding: 11px 14px`).
   - Long emails, file paths, and session previews wrap safely (`overflow-wrap: anywhere; word-break: break-word`).
2. **Laptop (`1000×700`):**
   - `main` container centered at `max-width: 1000px; padding: 18px 22px`.
   - `.grid` renders 3–4 account cards per row (`repeat(auto-fill, minmax(230px, 1fr))`).
   - `.kpi-grid` renders 4 telemetry cards across (`repeat(auto-fit, minmax(200px, 1fr))`).
3. **Desktop (`1440×900`):**
   - Balanced whitespace around the `1000px` telemetry column with sticky header.
