import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import '@aido/ui/theme.css';
import { App } from './App.js';

/**
 * The entry point both shells use.
 *
 * The same bundle is served by the Vite dev server, by the API in production and by the
 * Electron desktop app from its in-process server (§54), so there is exactly one UI.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Operational data is short-lived but not polling-heavy: the SSE stream pushes
      // changes, and a stale-while-revalidate window avoids refetch storms per view.
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: 0 },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
