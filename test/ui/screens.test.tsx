// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://aido.test/" }
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../../apps/web/src/App.js';

// React only runs effects and flushes updates synchronously inside `act` when it is told
// this is a test environment; without it every assertion races the first paint.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Screen smoke test (§39, §48).
 *
 * Every screen is mounted in a DOM against a **running API** — no mocks, no fixtures — and
 * asserted to reach a rendered state without throwing. The web client has no other
 * automated coverage: a screen that reads a field the API does not send, or crashes on an
 * empty list, fails here instead of in front of a user.
 *
 * It is skipped unless `AIDO_E2E_BASE_URL` points at a live server, because the point is
 * to exercise the real contract end to end:
 *
 *   npm run build:web && AIDO_E2E_BASE_URL=http://127.0.0.1:8787 npx vitest run test/ui
 *
 * `EventSource` does not exist in jsdom; the live-events hook treats that as "no stream"
 * and the screens still render, which is also the behaviour a browser without SSE would get.
 */

/**
 * The DOM origin is a deliberate placeholder (`http://aido.test/`, see the options above):
 * the client resolves its relative URLs against `location.origin`, so the test rewrites
 * every request from that origin to the real API address.
 */
const JSDOM_ORIGIN = 'http://aido.test';
const baseUrl = (process.env.AIDO_E2E_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

/**
 * The screens need a server, so the suite skips (loudly) rather than failing when none is
 * running: `npm test` must stay green on a machine that has only checked out the code.
 */
const reachable = await (async (): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
})();
if (!reachable) {
  console.warn(`[screens] no API at ${baseUrl} — start one with \`npm run dev:api\` or set AIDO_E2E_BASE_URL to run these tests.`);
}
const describeLive = reachable ? describe : describe.skip;

const ROUTES: { path: string; expect: RegExp }[] = [
  { path: '/', expect: /dashboard|projects|active run/i },
  { path: '/projects', expect: /projects/i },
  { path: '/tasks', expect: /tasks/i },
  { path: '/agents', expect: /agents|roles/i },
  { path: '/agents/architect', expect: /architect/i },
  { path: '/providers', expect: /providers/i },
  { path: '/providers/simulated', expect: /simulator|simulated/i },
  { path: '/models', expect: /models/i },
  { path: '/quotas', expect: /quota/i },
  { path: '/activity', expect: /activity|events/i },
  { path: '/git', expect: /git/i },
  { path: '/tests', expect: /tests/i },
  { path: '/performance', expect: /performance/i },
  { path: '/settings', expect: /settings/i },
];

let projectId: string | null = null;
beforeAll(async () => {
  installFetch();
  const response = await fetch(`${baseUrl}/api/projects`);
  const projects = (await response.json()) as { id: string }[];
  projectId = projects[0]?.id ?? null;
});

/** Rewrites requests addressed to the placeholder origin onto the live server. */
function installFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (raw.startsWith(JSDOM_ORIGIN)) return real(`${baseUrl}${raw.slice(JSDOM_ORIGIN.length)}`, init);
    return real(input as RequestInfo, init);
  }) as typeof fetch;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderPath(path: string, expect?: RegExp): Promise<string> {
  installFetch();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });

  // Screens fetch on mount and render skeletons while loading. Waiting on "the text
  // stopped changing" is not enough — a skeleton page is stable and empty — so poll until
  // the screen shows what the caller is looking for, with a floor so pending fetches land,
  // and a deadline so a genuinely broken screen fails the assertion rather than hanging.
  const deadline = Date.now() + 10_000;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  let text = (container.textContent ?? '').trim();
  while (Date.now() < deadline) {
    if (expect?.test(text)) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const next = (container.textContent ?? '').trim();
    if (expect === undefined && next === text) break;
    text = next;
  }
  return text;
}

function expectNoErrorScreen(text: string): void {
  expect(text).not.toMatch(/could not be loaded/i);
  expect(text).not.toMatch(/Uncaught|TypeError|undefined is not/i);
}

describeLive('web screens render against the live API', () => {
  for (const route of ROUTES) {
    it(`renders ${route.path}`, async () => {
      const text = await renderPath(route.path, route.expect);
      expect(text.length).toBeGreaterThan(50);
      expect(text).toMatch(route.expect);
      expectNoErrorScreen(text);
    });
  }

  it('renders every project tab against a real project', async () => {
    expect(projectId, 'no project exists to render').not.toBeNull();
    const id = projectId as string;
    const tabs = ['', '/tasks', '/graph', '/files', '/memory', '/messages', '/executions', '/tests', '/supervision'];
    for (const tab of tabs) {
      const text = await renderPath(`/projects/${id}${tab}`);
      expect(text.length, `/projects/:id${tab} rendered nothing`).toBeGreaterThan(50);
      expectNoErrorScreen(text);
      // The project screen must show the project it loaded, not a fallback.
      expect(text).toMatch(/markdown|project/i);
    }
  });

  it('shows the FREE ONLY control and the desktop badge state', async () => {
    const text = await renderPath('/');
    expect(text).toMatch(/free only/i);
    // No desktop bridge in jsdom, so the shell must not claim to be the desktop app.
    expect(text).not.toMatch(/desktop app/i);
  });
});
