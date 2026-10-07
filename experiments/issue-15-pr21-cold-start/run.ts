import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const experimentPath = import.meta.dir;
const repositoryRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const serverPort = 4189;

const server = Bun.serve({
  port: serverPort,
  async fetch(request) {
    const url = new URL(request.url);
    const relativePath = url.pathname === "/" ? "/experiments/issue-15-pr21-cold-start/index.html" : url.pathname;
    const file = Bun.file(`${repositoryRoot}${relativePath}`);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

type CdpResponse = { id?: number; result?: unknown; error?: unknown };

async function waitForDebugger(port: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find(
        (entry: { type: string; url: string }) =>
          entry.type === "page" && entry.url.includes(`127.0.0.1:${serverPort}`),
      );
      if (page) return page.webSocketDebuggerUrl as string;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Chrome debugging endpoint did not start on port ${port}`);
}

async function runTrial(cue: string, leadMs: number, repetition: number, trialIndex: number) {
  const debuggingPort = 9400 + trialIndex;
  const profileDirectory = await mkdtemp(join(tmpdir(), `morpheus-audio-${trialIndex}-`));
  const trial = `${cue}-${leadMs}ms-${repetition}`;
  const url = `http://127.0.0.1:${serverPort}/experiments/issue-15-pr21-cold-start/index.html?cue=${cue}&leadMs=${leadMs}&trial=${trial}`;
  const chrome = Bun.spawn([
    chromePath,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    url,
  ], { stdout: "ignore", stderr: "ignore" });

  try {
    const webSocketUrl = await waitForDebugger(debuggingPort);
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map<number, (response: CdpResponse) => void>();
    let requestId = 0;

    socket.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data)) as CdpResponse;
      if (response.id) pending.get(response.id)?.(response);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });

    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<CdpResponse>((resolve) => {
        const id = ++requestId;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send("Runtime.enable");
    await send("Page.enable");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const locationResponse = await send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const currentUrl = (locationResponse.result as { result: { value?: string } }).result.value;
      if (currentUrl?.includes(`127.0.0.1:${serverPort}`)) break;
      await Bun.sleep(25);
    }
    await send("Runtime.evaluate", {
      expression: "new Promise(resolve => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, { once: true }))",
      awaitPromise: true,
    });
    const boundsResponse = await send("Runtime.evaluate", {
      expression: "JSON.stringify(document.querySelector('#run').getBoundingClientRect())",
      returnByValue: true,
    });
    const boundsValue = (boundsResponse.result as { result: { value: string } }).result.value;
    if (!boundsValue) {
      const pageDiagnostic = await send("Runtime.evaluate", {
        expression: "JSON.stringify({ href: location.href, title: document.title, body: document.body?.innerText })",
        returnByValue: true,
      });
      throw new Error(`Could not resolve run button: ${JSON.stringify({ boundsResponse, pageDiagnostic })}`);
    }
    const bounds = JSON.parse(boundsValue) as { x: number; y: number; width: number; height: number };
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await send("Page.bringToFront");
    for (let inputAttempt = 0; inputAttempt < 5; inputAttempt += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await Bun.sleep(50);
      const clickResponse = await send("Runtime.evaluate", {
        expression: "document.querySelector('#run').disabled",
        returnByValue: true,
      });
      const clickRegistered = (clickResponse.result as { result: { value?: boolean } }).result.value;
      if (clickRegistered) break;
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const resultResponse = await send("Runtime.evaluate", {
        expression: "window.__experimentResult ?? null",
        returnByValue: true,
      });
      const value = (resultResponse.result as { result: { value?: unknown } }).result.value;
      if (value) {
        socket.close();
        return value;
      }
      await Bun.sleep(25);
    }
    const diagnosticResponse = await send("Runtime.evaluate", {
      expression: "({ errors: window.__experimentErrors, resultText: document.querySelector('#result')?.textContent, readyState: document.readyState })",
      returnByValue: true,
    });
    throw new Error(`Trial timed out: ${trial}; ${JSON.stringify(diagnosticResponse.result)}`);
  } finally {
    chrome.kill();
    await chrome.exited;
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

const results = [];
let trialIndex = 0;
const cuesArgument = process.argv.find((argument) => argument.startsWith("--cues="));
const cues = cuesArgument
  ? cuesArgument.split("=")[1].split(",")
  : process.argv.includes("--press-only")
    ? ["press"]
    : ["tap", "select"];
const leadsArgument = process.argv.find((argument) => argument.startsWith("--leads="));
const leads = (leadsArgument?.split("=")[1] ?? "0,5,10,20,40")
  .split(",")
  .map(Number);
const repetitionsArgument = process.argv.find((argument) => argument.startsWith("--repetitions="));
const repetitions = Number(repetitionsArgument?.split("=")[1] ?? 20);
try {
  for (const cue of cues) {
    for (const leadMs of leads) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        results.push(await runTrial(cue, leadMs, repetition, trialIndex++));
      }
    }
  }
  if (process.argv.includes("--summary")) {
    const summary = Object.values(
      results.reduce<Record<string, { cue: string; scheduleLeadMs: number; detected: number; trials: number; peaks: number[] }>>(
        (groups, result) => {
          const typedResult = result as { cue: string; scheduleLeadMs: number; peak: number };
          const key = `${typedResult.cue}-${typedResult.scheduleLeadMs}`;
          const group = (groups[key] ??= {
            cue: typedResult.cue,
            scheduleLeadMs: typedResult.scheduleLeadMs,
            detected: 0,
            trials: 0,
            peaks: [],
          });
          group.trials += 1;
          group.detected += Number(typedResult.peak > 0.0001);
          group.peaks.push(typedResult.peak);
          return groups;
        },
        {},
      ),
    ).map(({ peaks, ...group }) => ({
      ...group,
      medianPeak: [...peaks].sort((a, b) => a - b)[Math.floor(peaks.length / 2)],
      minPeak: Math.min(...peaks),
      maxPeak: Math.max(...peaks),
    }));
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
} finally {
  server.stop(true);
}
