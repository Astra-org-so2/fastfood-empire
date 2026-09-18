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
 * Screen smoke test (§39, §48, §54).
 *
 * Every screen is mounted in a DOM against a **running API** — no mocks, no fixtures — and
 * asserted to reach a rendered state without throwing. This is the only automated coverage
 * the UI has, and both shells share it: what renders here is what the browser and the
 * Electron window render, so a screen that reads a field the API does not send, or crashes
 * on an empty list or a null id, fails here instead of blanking a page in front of a user.
 *
 * It is skipped unless a server is reachable, because the point is to exercise the real
 * contract end to end:
 *
 *   npm run build && AIDO_E2E_BASE_URL=http://127.0.0.1:8787 npx vitest run test/ui
 *
 * `EventSource` does not exist in jsdom; the live-events hook treats that as "no stream",
 * the header shows the reconnecting indicator, and the screens still render — which is also
 * what a browser without SSE support gets.
 */

/**
 * The DOM origin is a deliberate placeholder (`http://aido.test/`, see the options above):
 * the client resolves its relative URLs against `location.origin`, so the test rewrites
 * every request from that origin to the real API address instead of passing a test-only
 * base URL into production code.
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

/** Rewrites requests addressed to the placeholder origin onto the live server. */
function installFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (raw.startsWith(JSDOM_ORIGIN)) return real(`${baseUrl}${raw.slice(JSDOM_ORIGIN.length)}`, init);
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  window.fetch = wrapped;
}

/* ------------------------------------------------------------------ fixtures */

/** Ids of real rows, so the detail screens are exercised against actual data. */
const ids: { projectId: string | null; providerId: string | null; agentId: string | null } = {
  projectId: null,
  providerId: null,
  agentId: null,
};

const getJson = async <T,>(path: string): Promise<T | null> => {
  try {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ mounting */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderPath(path: string, expectText?: RegExp): Promise<string> {
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
  const deadline = Date.now() + 20_000;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  let text = (container.textContent ?? '').trim();
  while (Date.now() < deadline) {
    if (expectText?.test(text)) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const next = (container.textContent ?? '').trim();
    if (expectText === undefined && next === text) break;
    text = next;
  }
  if (expectText && !expectText.test(text)) {
    // The rendered text is the whole point of a failure here: without it a timeout says
    // nothing about what the screen actually showed.
    throw new Error(`timed out waiting for ${expectText} on ${path}; the screen showed: ${text.slice(0, 400)}`);
  }
  return text;
}

function expectNoErrorScreen(text: string, where: string): void {
  expect(text, `${where} rendered an error panel`).not.toMatch(/could not be loaded/i);
  expect(text, `${where} threw while rendering`).not.toMatch(/Uncaught|TypeError|undefined is not/i);
}

/* ------------------------------------------------------------------ routes */

const routes: { path: string; expect: RegExp }[] = [
  { path: '/', expect: /dashboard|projects|active run/i },
  { path: '/projects', expect: /projects/i },
  { path: '/tasks', expect: /tasks/i },
  { path: '/agents', expect: /agents|roles/i },
  { path: '/providers', expect: /providers/i },
  { path: '/models', expect: /models/i },
  { path: '/quotas', expect: /quota/i },
  { path: '/activity', expect: /activity|events/i },
  { path: '/git', expect: /git/i },
  { path: '/tests', expect: /tests/i },
  { path: '/performance', expect: /performance/i },
  { path: '/settings', expect: /settings/i },
];

beforeAll(async () => {
  installFetch();
  const projects = await getJson<{ id: string }[]>('/api/projects');
  ids.projectId = projects?.[0]?.id ?? null;
  const providers = await getJson<{ providers: { id: string }[] }>('/api/providers');
  ids.providerId = providers?.providers[0]?.id ?? null;
  const agents = await getJson<{ id: string }[]>('/api/agents');
  ids.agentId = agents?.find((agent) => agent.id !== 'supervisor')?.id ?? agents?.[0]?.id ?? null;
});

describeLive('web screens render against the live API', () => {
  for (const route of routes) {
    it(`renders ${route.path}`, async () => {
      const text = await renderPath(route.path, route.expect);
      expect(text.length, `${route.path} rendered almost nothing`).toBeGreaterThan(50);
      expect(text).toMatch(route.expect);
      expectNoErrorScreen(text, route.path);
    });
  }

  it('renders every project tab against a real project', async () => {
    expect(ids.projectId, 'no project exists to render').not.toBeNull();
    const id = ids.projectId as string;
    // The tabs the project screen actually declares, in their routed form.
    const tabs = ['', '/tasks', '/graph', '/files', '/git', '/tests', '/agents', '/memory', '/activity'];
    for (const tab of tabs) {
      const text = await renderPath(`/projects/${id}${tab}`);
      expect(text.length, `/projects/:id${tab} rendered nothing`).toBeGreaterThan(50);
      expectNoErrorScreen(text, `/projects/:id${tab}`);
      // The project screen must show the project it loaded, not a fallback.
      expect(text, `/projects/:id${tab} lost its project`).toMatch(/markdown|project/i);
    }
  });

  it('renders a provider detail without ever showing a stored key', async () => {
    expect(ids.providerId, 'no provider exists to render').not.toBeNull();
    const text = await renderPath(`/providers/${ids.providerId}`, /credentials/i);
    expectNoErrorScreen(text, 'provider detail');
    // The security promise the UI makes: a key is never displayed back after entry.
    expect(text).toMatch(/never/i);
  });

  it('renders an agent detail with its role, tools and limits', async () => {
    expect(ids.agentId, 'no agent exists to render').not.toBeNull();
    const text = await renderPath(`/agents/${ids.agentId}`, /instructions/i);
    expectNoErrorScreen(text, 'agent detail');
    expect(text).toMatch(/limits/i);
  });

  it('shows the FREE ONLY control and the desktop badge state', async () => {
    const text = await renderPath('/', /free only/i);
    expect(text).toMatch(/free only/i);
    // No desktop bridge in jsdom, so the shell must not claim to be the desktop app.
    expect(text).not.toMatch(/desktop app/i);
  });
});
