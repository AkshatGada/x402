// Builds evidence/index.html from the saved runs (not part of any commit).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DIR, config, explorer, explorerAddress, keys } from "./lib.mts";
import { decode } from "./stores.mts";

const order = (d: string) => (d.startsWith("fix") ? 2 : d.includes("control") ? 1 : 0);
const runs = readdirSync(`${DIR}runs`)
  .filter(d => /^(baseline|fix)(-control-memory)?-\d/.test(d))
  .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const link = (url: string, text: string) => `<a href="${url}">${esc(text)}</a>`;
const fmt = (atomic: string | bigint) => (Number(atomic) / 1e6).toFixed(4);

type Run = ReturnType<typeof load>;
function load(dir: string) {
  const base = `${DIR}runs/${dir}`;
  const r = JSON.parse(readFileSync(`${base}/result.json`, "utf8"));
  const outcomes = JSON.parse(readFileSync(`${base}/outcomes.json`, "utf8")) as {
    round: number; replica: string; requestId: string; status: number; success: boolean;
    chargedAmount?: string; cumulative?: string; error?: string;
  }[];
  const db = new DatabaseSync(`${base}/run.db`, { readOnly: true });
  const control = dir.includes("control");
  const channel = control
    ? decode<{ channel: { reservations?: Record<string, unknown> } }>(readFileSync(`${base}/state.json`, "utf8")).channel
    : decode<{ reservations?: Record<string, unknown> }>(
        (db.prepare("SELECT json FROM channels WHERE id = ?").get(r.channelId) as { json: string }).json,
      );
  const served = new Set(
    (db.prepare("SELECT detail FROM events WHERE kind = 'handler_served'").all() as { detail: string }[])
      .map(e => String(decode<{ requestId: string }>(e.detail).requestId)),
  );
  const ops = new Map(
    control
      ? []
      : (db.prepare("SELECT request_id, json FROM operations").all() as { request_id: string; json: string }[])
          .map(o => [o.request_id, decode<{ status: string; actual?: bigint; cumulative?: bigint }>(o.json)]),
  );
  const clientLog = readFileSync(`${base}/client.log`, "utf8")
    .split("\n")
    .filter(l => l.startsWith("["))
    .join("\n");
  return {
    dir,
    label: r.label as "baseline" | "fix",
    control,
    r,
    outcomes,
    served,
    ops,
    orphanReservations: Object.keys(channel.reservations ?? {}).length,
    head: readFileSync(`${base}/git-head.txt`, "utf8").trim(),
    schemeSha: readFileSync(`${base}/scheme-vs-main.txt`, "utf8").match(/sha256: (\w+)/)?.[1] ?? "",
    clientLog,
  };
}
const all: Run[] = runs.map(load);
const payouts = JSON.parse(readFileSync(`${DIR}evidence/payouts.json`, "utf8")) as Record<
  string,
  { tx: string; url: string; payToDelta: string }[]
>;
const paid = (x: Run) => (payouts[x.dir] ?? []).filter(p => p.payToDelta !== "0");
const logged = (x: Run) => BigInt(x.r.operations.completedActualSum) + 2500n;
const k = await keys();
const { mint } = config();

const row = (label: string, cells: string[], warn: boolean[] = []) =>
  `<tr><th>${label}</th>${cells.map((c, i) => `<td class="${warn[i] ? "bad" : ""}">${c}</td>`).join("")}</tr>`;
const title = (x: Run) =>
  x.control ? "main + SDK MemoryChannelStore (control)" : x.label === "baseline" ? "main (baseline)" : "this PR (fix)";
const head = all
  .map(x => `<th class="${x.control ? "control" : x.label}">${title(x)}<br><span class="mono small">${x.dir.replace(/^.*-(\d{8}-\d{6})$/, "$1")}</span></th>`)
  .join("");
const phantom = (x: Run) => BigInt(x.r.operations.completedActualSum) - BigInt(x.r.serverChargedForWorkers);

const summary = `
<table class="grid">
<thead><tr><th></th>${head}</tr></thead>
<tbody>
${row("Server store", all.map(x => x.control ? "SDK <code>MemoryChannelStore</code> + <code>MemoryBatchOperationStore</code>, 1 replica" : "shared SQLite, optimistic retry, 2 replicas"))}
${row("Concurrent paid requests on one channel", all.map(x => String(x.r.requests)))}
${row("Handlers that ran (work done; on failure the middleware withholds the body)", all.map(x => String(x.r.handlerServed)))}
${row("Requests that got a successful <code>PAYMENT-RESPONSE</code>", all.map(x => `${x.r.succeeded} / ${x.r.requests}`), all.map(x => x.r.failed > 0))}
${row("Failed after the handler ran", all.map(x => String(x.r.failed)), all.map(x => x.r.failed > 0))}
${row("Error returned to the client", all.map(x => x.r.failureReasons.length ? `<code>${esc(x.r.failureReasons.join(", "))}</code>` : "none"), all.map(x => x.r.failed > 0))}
${row("Store write conflicts retried", all.map(x => x.control ? "n/a (in-process lock)" : String(x.r.storeWriteConflicts)))}
${row("Operations marked <code>completed</code> (sum of <code>actual</code>)", all.map(x => `${x.r.operations.completed} (${fmt(x.r.operations.completedActualSum)})`))}
${row("Charge recorded on the channel for these requests", all.map(x => fmt(x.r.serverChargedForWorkers)), all.map(x => phantom(x) > 0n))}
${row("&ldquo;Completed&rdquo; operations with no charge behind them", all.map(x => fmt(phantom(x))), all.map(x => phantom(x) > 0n))}
${row("Reservations still holding deposit after the run (expire after <code>maxTimeoutSeconds</code> = 300 s)", all.map(x => `${x.orphanReservations} (${fmt(BigInt(x.orphanReservations) * 10000n)} held)`), all.map(x => x.orphanReservations > 0))}
${row("Onchain <code>settled</code> after redemption (devnet)", all.map(x => fmt(x.r.onchainSettledAfterRedeem)))}
${row("Operation log total incl. the deposit request", all.map(x => fmt(logged(x))))}
${row("Paid to <code>payTo</code> onchain (distribute tx, from a chain scan)", all.map(x => paid(x).map(p => `${fmt(p.payToDelta)} · ${link(p.url, short(p.tx))}`).join("<br>")), all.map(x => paid(x).reduce((a, p) => a + BigInt(p.payToDelta), 0n) !== logged(x)))}
${row("Payer refund right after the run (cooperative close)", all.map(x => x.r.refund?.transaction ? link(explorer(x.r.refund.transaction), `closed, ${fmt(x.r.refund.amount)} returned`) : `<code>${esc(x.r.refundError ?? "")}</code>`), all.map(x => !x.r.refund?.transaction))}
${row("Channel (devnet)", all.map(x => link(x.r.channelUrl, short(x.r.channelId))))}
${row("Deposit / open tx", all.map(x => link(explorer(x.r.depositTx), short(x.r.depositTx))))}
${row("Claim tx", all.map(x => x.r.claimAndSettleTxs.map((t: { url: string; tx: string }) => link(t.url, short(t.tx))).join("<br>")))}
${row("<code>server/scheme.ts</code> sha256", all.map(x => `<span class="mono small">${x.schemeSha.slice(0, 12)}</span>`))}
</tbody></table>`;

const sample = all.find(x => x.label === "baseline")!;
const failedRows = sample.outcomes
  .filter(o => !o.success)
  .slice(0, 6)
  .map(o => {
    const op = sample.ops.get(o.requestId);
    return `<tr><td class="mono">${o.requestId.slice(0, 8)}</td><td>${o.replica}</td><td>${sample.served.has(o.requestId) ? "yes" : "no"}</td><td class="bad">${o.status}</td><td class="mono small">${esc(o.error)}</td><td class="bad">${op?.status} · actual ${op?.actual} · cumulative ${op?.cumulative}</td></tr>`;
  })
  .join("");

const logs = all
  .map(x => `<div class="term"><div class="term-title">${x.label} · ${x.dir} · client output</div><pre>${esc(x.clientLog)}</pre></div>`)
  .join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>SVM batch charge commit evidence</title>
<style>
:root{--fg:#1d1f23;--muted:#5d6470;--line:#d9dde3;--bad:#b42318;--badbg:#fef3f2;--ok:#067647;--bg:#fff;--code:#f4f5f7}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:28px 36px;max-width:1500px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
p{margin:6px 0;color:var(--muted)}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
code{background:var(--code);padding:1px 4px;border-radius:3px}.small{font-size:11.5px;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
.grid thead th{background:#f7f8fa}.grid tbody th{font-weight:500;width:30%;background:#fbfbfc}
th.baseline{color:var(--bad)}th.fix{color:var(--ok)}th.control{color:#475467}td.bad{background:var(--badbg);color:var(--bad);font-weight:600}
a{color:#175cd3;text-decoration:none}
.term{background:#0d1117;border-radius:8px;margin:10px 0;overflow:hidden}.term-title{background:#161b22;color:#8b949e;font:12px ui-monospace,Menlo,monospace;padding:6px 12px}
.term pre{color:#e6edf3;margin:0;padding:10px 12px;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.setup{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:8px}.box{border:1px solid var(--line);border-radius:6px;padding:8px 10px}.box b{display:block;margin-bottom:2px}
</style></head><body>
<h1>SVM batch-settlement: completing an operation inside the channel-store update</h1>
<p>Solana <b>devnet</b>, real <code>payment-channels</code> program <span class="mono">CHNLxYvV…GsX</span>. Same harness, same inputs; only <code>typescript/packages/mechanisms/svm/src/batch-settlement/server/scheme.ts</code> differs (main vs this branch). <code>@x402/svm</code> is rebuilt from source before each run.</p>
<div class="setup">
<div class="box"><b>Facilitator</b>x402 <code>BatchSvmScheme</code> facilitator on devnet (trimmed copy of <code>examples/typescript/facilitator/batch-settlement</code>). Opens, claims, distributes and closes channels onchain.</div>
<div class="box"><b>2 resource-server replicas</b><code>@x402/express</code> middleware + server-signed <code>BatchSvmScheme</code> (as in <code>examples/typescript/servers/batch-settlement</code>). Handler meters 25% of a 0.01 ceiling.</div>
<div class="box"><b>Shared durable store</b>One SQLite file. <code>ChannelStore.update</code> uses the optimistic read → update → compare-and-write → retry loop of x402's EVM <code>RedisChannelStorage</code>; operation store mirrors <code>MemoryBatchOperationStore</code>.</div>
<div class="box"><b>Payer</b>Official x402 client opens a server-signed channel (deposit 0.5 test tokens). Then 8 parallel workers per round × 3 rounds send signed per-request authorizations for that channel to both replicas.</div>
</div>
${summary}
<h2>Baseline failures: the handler ran, the client got a 402, the operation says it completed</h2>
<table><thead><tr><th>request</th><th>replica</th><th>handler ran</th><th>HTTP</th><th>error</th><th>operation record afterwards</th></tr></thead><tbody>${failedRows}</tbody></table>
<p class="small">From ${esc(sample.dir)}. The channel's <code>chargedCumulativeAmount</code> never included these charges, so the onchain claim settles less than the operation log reports.</p>
<h2>Go SDK: same race with goroutines (local, no chain)</h2>
<p>Throwaway test (not in the PR): 24 server-mode charges reserved on one channel, then settled from parallel goroutines through an in-memory compare-and-set <code>ChannelStore</code> (read a versioned record, run the updater without a lock, commit if the version is unchanged, else retry). Facilitator and chain are not involved. <code>go test -race</code>, 3 runs each, no data races.</p>
<div class="term"><div class="term-title">go/mechanisms/svm/batch-settlement/server · TestEvidenceConcurrentChargesWithCASStore</div><pre>${esc(readFileSync(`${DIR}evidence/go-concurrent-evidence.txt`, "utf8").replace(/github.com\/x402-foundation\/x402\/go\/v2\//g, ""))}</pre></div>
<h2>Scope and caveats</h2>
<ul>
<li>The official TS client sends one server-signed request per channel at a time. The parallel workers here model several clients or agent workers paying from the same channel; the spec lets server-mode handlers run concurrently and the server cannot rely on clients serializing. Their payloads are built with the SDK's <code>signBatchAuthorization</code> against the channel the official client opened.</li>
<li><b>Trigger.</b> The control column shows main passing 24/24 with the SDK's in-memory stores under the same load. The failures need a store that re-runs the update callback after a write conflict (the shared SQLite store here uses the same optimistic loop as x402's EVM <code>RedisChannelStorage</code>) or whose write fails after the callback ran. Conflicts also happen inside one process, because the updater awaits voucher signing between its read and its compare-and-write; two replicas are not required.</li>
<li><b>Contracts.</b> Go's <code>ChannelStore</code> says only &ldquo;Update is atomic per channel&rdquo;; it does not say whether the updater may run more than once. The TS interface says the updater runs with exclusive access and concurrent updates queue, so an optimistic TS store is outside that wording; for TS this change is hardening, plus the failed-write path, which is within either contract and is covered by unit tests in both SDKs.</li>
<li><b>Trade-off.</b> With the fix, if <code>operationStore.complete</code> fails after the channel commit, the charge stays on the channel, the operation stays <code>reserved</code> (the request id is still fenced) and the request returns 402. On main the same failure leaves a <code>completed</code> operation with no charge. Neither is atomic; the PR states this.</li>
<li><b>What the harm is.</b> On main the failed requests' bodies were withheld, so payers were not served for free and no funds were lost. The harm is merchant work done without a charge, an operation log that does not match the channel or the chain, and deposit held by reservations that block the payer's close until they expire.</li>
<li><b>Held reservations</b> come from core not running <code>onSettleFailure</code> after a <code>beforeSettle</code> abort, so any abort holds its reservation until expiry (300 s). This PR removes these aborts, not that general behaviour. <code>duplicate_settlement</code> is the SDK's busy code returned to the refund.</li>
<li><b>Payout figures</b> come from scanning the payTo token account for transactions that touch each channel. The redemption worker logged <code>distribute failed: settlement_pending</code> (slow devnet confirmation) in both arms before the distribute landed; this does not affect the comparison.</li>
<li><b>All runs disclosed.</b> Two earlier baseline runs are not in the table: one stopped on a devnet RPC 429 before it saved results (its store showed the same 16 failures), and one completed 8/24 with the same failure before the error message was being recorded.</li>
<li>Devnet only, with a worthless test mint. The facilitator is a trimmed copy of the example; the harness itself is not part of the PR.</li>
</ul>
<h2>Client output</h2>${logs}
<p class="small">Test mint ${link(explorerAddress(mint), short(mint))} (devnet, worthless). payTo ${link(explorerAddress(k.payTo.address), short(k.payTo.address))}. Branch HEAD ${esc(all[0]?.head ?? "")}. Generated ${new Date().toISOString()}.</p>
</body></html>`;

mkdirSync(`${DIR}evidence`, { recursive: true });
writeFileSync(`${DIR}evidence/index.html`, html);
writeFileSync(
  `${DIR}evidence/summary.json`,
  JSON.stringify(all.map(({ outcomes, served, ops, clientLog, ...x }) => x), null, 2),
);
console.log("wrote evidence/index.html for", all.map(x => x.dir).join(", "));
