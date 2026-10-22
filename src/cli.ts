#!/usr/bin/env node
import { runScenario, type AttemptLogEntry } from "./simulator.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const started = performance.now();
const result = await runScenario({
  messages: arg("messages", 120),
  seed: arg("seed", 7),
  workers: arg("workers", 1),
});
const elapsed = performance.now() - started;

process.exitCode = result.exactlyOnce ? 0 : 1;
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  report();
}

function report(): void {
  const color = process.stdout.isTTY || process.env.FORCE_COLOR ? true : false;
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = paint("2");
  const ok = paint("38;2;111;242;198");
  const warn = paint("38;2;242;196;109");
  const bad = paint("38;2;255;123;138");
  const clock = (t: number) => new Date(t).toISOString().slice(11, 19);
  const span = (ms: number) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  };

  const out: string[] = [];
  out.push("");
  out.push(`  ${result.messages} messages published to ${result.endpoints.length} endpoints over 5 minutes, ${result.deliveries} deliveries`);
  out.push("");
  out.push(`  ${dim("ENDPOINTS")}`);
  out.push("");
  for (const e of result.endpoints) {
    const notes = [
      e.retries ? `${e.retries} retries` : "",
      e.duplicatesAbsorbed ? `${e.duplicatesAbsorbed} duplicates absorbed` : "",
      e.breakerOpenings ? `breaker opened ${e.breakerOpenings}×` : "",
      e.deadLettered ? `${e.deadLettered} dead letters, redelivered` : "",
    ].filter(Boolean);
    out.push(`  ${e.id.padEnd(10)} ${dim(e.behaviour.padEnd(36))} ${`${e.processedOnce}/${e.expected}`.padStart(7)}   ${notes.join(", ")}`);
  }

  // The message whose story covers the most kinds of failure.
  const byMessage = new Map<string, AttemptLogEntry[]>();
  for (const l of result.log) byMessage.set(l.messageId, [...(byMessage.get(l.messageId) ?? []), l]);
  const variety = (ls: AttemptLogEntry[]) =>
    new Set(ls.filter((l) => l.result !== "delivered").map((l) => l.endpointId)).size * 10 +
    (ls.some((l) => l.breakerOpenedUntil) ? 25 : 0) -
    ls.length;
  const [messageId, story] = [...byMessage].sort((a, b) => variety(b[1]) - variety(a[1]))[0]!;

  out.push("");
  out.push(`  ${dim(`ONE MESSAGE: ${messageId}`)}`);
  out.push("");
  const wasDead = new Set<string>();
  for (const l of story) {
    const status = (l.error ?? String(l.status)).padEnd(13);
    const what =
      l.result === "delivered"
        ? ok(wasDead.has(l.endpointId) ? "delivered after redelivery" : "delivered")
        : l.result === "dead"
          ? bad(`dead letter (${l.deadReason})`)
          : warn(`retry in ${span(l.nextAttemptAt! - l.at)}`) + (l.breakerOpenedUntil ? dim(`, breaker open for ${span(l.breakerOpenedUntil - l.at)}`) : "");
    if (l.result === "dead") wasDead.add(l.endpointId);
    out.push(`  ${dim(clock(l.at))}  ${l.endpointId.padEnd(10)} ${status} ${what}`);
  }

  out.push("");
  const mark = result.exactlyOnce ? ok("✓") : bad("✗");
  out.push(`  ${mark} ${result.deliveries} deliveries, each handled exactly once by its receiver`);
  if (result.redelivered) {
    out.push(`  ${ok("✓")} ${result.redelivered} dead letters redelivered after the receiver's secret was fixed`);
  }
  out.push(
    dim(
      `  ${result.attempts} requests, ${result.retries} retries, ${result.duplicatesAbsorbed} duplicates absorbed, ` +
        `${span(result.finishedAt - result.startedAt)} simulated in ${Math.round(elapsed)} ms`,
    ),
  );
  out.push("");
  console.log(out.join("\n"));
}
