import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { Badge, Button, ErrorState, formatDateTime, formatDuration, LoadingRows, Panel } from '@aido/ui';
import { api, useTests } from '../lib/api.js';
import { Mono, PageHeader, ProjectPicker, Section, TimeAgo, useProjectSelection } from '../components/common.js';

/**
 * Tests across projects (§20, §39).
 *
 * Test runs are recorded whenever they happen: from the QA agent's sandbox execution or
 * from the button here. A run that could not execute (no test command, sandbox refused)
 * is stored with its failure reason rather than silently skipped — "no test results" and
 * "tests failed" are different states and the UI must not blur them.
 */
export function TestsScreen(): ReactNode {
  const [active, setProjectId, projects] = useProjectSelection();
  const tests = useTests(active ?? undefined);
  const [action, setAction] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Tests"
        subtitle="Recorded test runs for the selected project, with the cases each run reported."
        actions={
          <>
            <ProjectPicker value={active} onChange={setProjectId} />
            <Button
              variant="primary"
              icon={<Play className="size-3.5" />}
              disabled={!active}
              loading={action === 'running'}
              onClick={async () => {
                if (!active) return;
                setAction('running');
                try {
                  const result = await api.runTests(active);
                  setAction(result.detail ?? (result.ok ? 'Test run started.' : 'The test run did not start.'));
                } catch (err) {
                  setAction(err instanceof Error ? err.message : String(err));
                } finally {
                  await tests.refetch();
                }
              }}
            >
              Run tests
            </Button>
          </>
        }
      />

      {projects.isLoading ? <LoadingRows rows={5} /> : null}
      {projects.isEmpty ? <Panel className="p-6 text-center text-[12px] text-muted">No projects yet, so no test runs exist.</Panel> : null}

      {action ? (
        <div className="mb-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {action}
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setAction(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      {active ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <Section title="Summary" className="lg:col-span-1">
            {tests.isLoading ? <LoadingRows rows={4} /> : null}
            {tests.error ? <ErrorState title="Test state could not be loaded" detail={(tests.error as Error).message} retry={() => void tests.refetch()} /> : null}
            {tests.data ? (
              <div className="space-y-1.5 px-3 py-2 text-[12px]">
                <Row label="Runs recorded" value={tests.data.summary.runs} />
                <Row label="Passing" value={tests.data.summary.passed} />
                <Row label="Failing" value={tests.data.summary.failed} tone={tests.data.summary.failed ? 'danger' : undefined} />
                <Row
                  label="Last status"
                  value={tests.data.summary.lastStatus ? <Badge tone={tests.data.summary.lastStatus === 'passed' ? 'free' : 'danger'}>{tests.data.summary.lastStatus}</Badge> : <span className="text-faint">never run</span>}
                />
                {tests.data.summary.runs === 0 ? (
                  <p className="pt-1 text-[11px] text-faint">
                    No run has been recorded yet. QA runs the project's own test command inside the sandbox; the button above triggers the same command manually.
                  </p>
                ) : null}
                <Link to={`/projects/${active}/tests`} className="inline-block pt-1 text-[11px] text-accent hover:underline">
                  open in project →
                </Link>
              </div>
            ) : null}
          </Section>

          <Section title="Runs" className="lg:col-span-2">
            {tests.data ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Command</th>
                    <th>Passed</th>
                    <th>Failed</th>
                    <th>Duration</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.data.runs.map((run) => (
                    <tr key={run.id} className="row-hover">
                      <td>
                        <Badge tone={run.status === 'passed' ? 'free' : run.status === 'failed' ? 'danger' : 'neutral'}>{run.status}</Badge>
                      </td>
                      <td className="max-w-[320px] truncate">
                        <Mono>{run.command ?? 'not recorded'}</Mono>
                      </td>
                      <td className="tabular">{run.passed ?? '—'}</td>
                      <td className="tabular">{run.failed ?? '—'}</td>
                      <td className="tabular">{run.durationMs !== undefined ? formatDuration(run.durationMs) : '—'}</td>
                      <td title={formatDateTime(run.startedAt)}>
                        <TimeAgo iso={run.startedAt} />
                      </td>
                    </tr>
                  ))}
                  {tests.data.runs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-muted">
                        Nothing recorded.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : null}
          </Section>

          {tests.data && tests.data.cases.length ? (
            <Section title={`Cases (${tests.data.cases.length})`} className="lg:col-span-3">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.data.cases.map((testCase, index) => (
                    <tr key={`${testCase.name}-${index}`} className="row-hover">
                      <td className="max-w-[420px] truncate">{testCase.name}</td>
                      <td>
                        <Badge tone={testCase.status === 'passed' ? 'free' : 'danger'}>{testCase.status}</Badge>
                      </td>
                      <td className="tabular">{testCase.durationMs !== undefined ? formatDuration(testCase.durationMs) : '—'}</td>
                      <td className="max-w-[420px] truncate text-muted">{testCase.message ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' }): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-faint">{label}</span>
      <span className={tone === 'danger' ? 'tabular text-danger' : 'tabular text-ink'}>{value}</span>
    </div>
  );
}
