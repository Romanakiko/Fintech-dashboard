// Loads the production build in headless Chrome, served with the render.yaml headers
// (serve-dist.mjs), and fails on any CSP violation, console error or uncaught exception in
// the page or the producer worker. It passes only once the dashboard shows generated prices,
// which proves that the worker started and the Wasm compiled under the policy, and once the
// /settings deep link has rendered. It also checks that the pages and the worker script are
// sent the render.yaml policy at all. Uses the installed Chrome (or CHROME_PATH).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSite, serveDist } from './serve-dist.mjs';

const TIMEOUT_MS = 15_000;

/** Each page and what must be true before it counts as working. */
const PAGES = [
  {
    path: '/',
    ready: `document.querySelector('app-market-table tbody td')?.textContent.includes('$')`,
    description: 'the dashboard shows generated prices',
  },
  {
    path: '/settings',
    ready: `document.querySelector('h1')?.textContent === 'Producer settings' &&
      document.querySelector('app-producer-status')?.textContent.includes('Running')`,
    description: 'the settings deep link renders and the producer runs',
  },
];

function chromePath() {
  const candidates = {
    win32: ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData'].map(
      (root) => `${process.env[root]}\\Google\\Chrome\\Application\\chrome.exe`,
    ),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform];
  const found = [process.env.CHROME_PATH, ...(candidates ?? [])].find(
    (path) => path && existsSync(path),
  );
  if (!found) {
    throw new Error('Chrome was not found. Set CHROME_PATH to a Chrome or Chromium binary.');
  }
  return found;
}

/** A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
  });
  const pending = new Map();
  const listeners = [];
  let nextId = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id === undefined) {
      listeners.forEach((listener) => listener(message));
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  };
  // If Chrome goes away, fail the requests still waiting for a reply instead of hanging.
  socket.onclose = () => {
    pending.forEach(({ reject }) => reject(new Error('Chrome closed the DevTools connection')));
    pending.clear();
  };
  return {
    send(method, params = {}, sessionId = undefined) {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('Chrome closed the DevTools connection'));
      }
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onEvent: (listener) => listeners.push(listener),
  };
}

/** Starts headless Chrome with a throwaway profile. */
async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'fintech-chrome-'));
  const chrome = spawn(
    chromePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        resolve(match[1]);
      }
    });
    exited.then((code) => reject(new Error(`Chrome exited with ${code}: ${output}`)));
  });
  const cdp = await connect(endpoint);
  return {
    cdp,
    async close() {
      await cdp.send('Browser.close').catch(() => chrome.kill());
      await exited;
      // A leftover temp folder must not replace the check's own result.
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        (error) => console.warn(`Could not remove ${profile}: ${error.message}`),
      );
    },
  };
}

/**
 * Opens a tab and reports every error it or its workers log. Workers are paused at start
 * until they are watched, so not even their first message is missed.
 */
async function openPage(cdp, report) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessions = new Map([[sessionId, 'page']]);
  const watch = (session) =>
    Promise.all([cdp.send('Runtime.enable', {}, session), cdp.send('Log.enable', {}, session)]);

  cdp.onEvent(({ method, params, sessionId: from }) => {
    const where = sessions.get(from);
    if (where === undefined) {
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const type = params.targetInfo.type;
      sessions.set(params.sessionId, type);
      watch(params.sessionId)
        .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId))
        .catch((error) => report(`${type}: could not be watched: ${error.message}`));
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      report(`${where}: ${params.entry.text} ${params.entry.url ?? ''}`.trim());
    } else if (method === 'Runtime.exceptionThrown') {
      const { exception, text } = params.exceptionDetails;
      report(`${where}: ${exception?.description ?? text}`);
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const args = params.args.map((arg) => arg.value ?? arg.description);
      report(`${where}: console.error ${args.join(' ')}`);
    }
  });
  await watch(sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );

  const evaluate = async (expression) => {
    const { result } = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    return result.value;
  };
  return {
    evaluate,
    goto: (url) => cdp.send('Page.navigate', { url }, sessionId),
    async waitFor(expression, description, timeoutMs = TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // Fails while a navigation replaces the page's context; the next poll retries.
        if ((await evaluate(expression).catch(() => false)) === true) {
          return;
        }
        await sleep(100);
      }
      throw new Error(`Timed out waiting until ${description}`);
    },
  };
}

async function main() {
  const site = await loadSite();
  const html = await readFile(join(site.root, 'index.html'), 'utf8').catch(() => {
    throw new Error(`No build in ${site.root}. Run \`npm run build\` first.`);
  });
  const problems = [];
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) {
    problems.push('index.html: inline <script>, which script-src blocks');
  }
  if (/<[^>]+\son[a-z]+\s*=/i.test(html)) {
    problems.push('index.html: inline event handler, which script-src blocks');
  }

  const server = await serveDist(site);

  // A policy that is not sent blocks nothing, and the browser run below would still pass.
  const policy = site.headers.find(({ name }) => name === 'Content-Security-Policy')?.value;
  const worker = (await readdir(site.root)).find((file) => /^worker-.+\.js$/.test(file));
  if (policy === undefined || worker === undefined) {
    problems.push(policy === undefined ? 'render.yaml sets no CSP' : 'no worker-*.js in the build');
  } else {
    for (const path of [...PAGES.map(({ path }) => path), `/${worker}`]) {
      const response = await fetch(server.origin + path, { method: 'HEAD' });
      const sent = response.headers.get('Content-Security-Policy');
      if (sent !== policy) {
        problems.push(
          `${path}: sent ${sent === null ? 'no CSP' : `"${sent}"`}, not the render.yaml policy`,
        );
      }
    }
  }

  const browser = await launchChrome();
  let page;
  try {
    page = await openPage(browser.cdp, (problem) => problems.push(problem));
    for (const { path, ready, description } of PAGES) {
      await page.goto(server.origin + path);
      await page.waitFor(ready, `${description} (${path})`);
    }
    await sleep(500); // Let late reports arrive.
  } catch (error) {
    problems.push(error.message);
    // A blocked Wasm compile is caught by the worker and shown in the error banner, not logged.
    const banner = await page
      ?.evaluate(`document.querySelector('[role=alert]')?.innerText.replaceAll('\\n', ' ')`)
      .catch(() => undefined);
    if (banner) {
      problems.push(`error banner: ${banner}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (problems.length > 0) {
    console.error(`CSP check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    process.exit(1);
  }
  console.log(
    `CSP check passed: ${PAGES.map(({ path }) => path).join(', ')} loaded with the render.yaml ` +
      'headers, the worker and Wasm ran, and nothing was blocked or logged as an error.',
  );
}

await main();
