import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, GitMerge } from 'lucide-react';
import { Badge, Button, cx, ErrorState, formatDateTime, LoadingRows, Modal, Panel } from '@aido/ui';
import { api, useProjects, useGitLog, useGitStatus } from '../lib/api.js';
import { AgentLink, Mono, PageHeader, Section, TimeAgo } from '../components/common.js';

/**
 * Git across projects (§17, §39).
 *
 * Agents work on their own branches, so this is the screen for reviewing what they did:
 * which branches exist, what is uncommitted, and the commit log with the agent that
 * produced each change. Merge conflicts are reported with the conflicting paths instead
 * of being resolved silently — a silent resolution would hide a real change collision.
 */
export function GitScreen(): ReactNode {
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const active = projectId ?? projects.data?.[0]?.id ?? null;
  const status = useGitStatus(active ?? undefined);
  const log = useGitLog(active ?? undefined);
  const [diff, setDiff] = useState<{ label: string; text: string } | null>(null);
  const [mergeBranch, setMergeBranch] = useState<string | null>(null);
  const [mergeResult, setMergeResult] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Git"
        subtitle="Every project keeps its own repository; each agent works on a branch named after its role and task."
        actions={
          projects.data && projects.data.length > 1 ? (
            <select
              value={active ?? ''}
              onChange={(event) => setProjectId(event.target.value)}
              className="h-7 rounded-[var(--radius-sm)] border border-line bg-inset px-2 text-[12px] text-ink"
              aria-label="Project"
            >
              {projects.data.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null
        }
      />

      {projects.isLoading ? <LoadingRows rows={6} /> : null}
      {projects.data && projects.data.length === 0 ? (
        <Panel className="p-6 text-center text-[12px] text-muted">No projects yet. Create one — the workspace is initialised as a Git repository with a main branch.</Panel>
      ) : null}
      {projects.error ? <ErrorState title="Projects could not be loaded" detail={(projects.error as Error).message} retry={() => void projects.refetch()} /> : null}

      {active ? (
        <div className="grid gap-3 lg:grid-cols-3">
          <Section
            title="Repository"
            className="lg:col-span-1"
            actions={
              <Button
                variant="ghost"
                onClick={async () => {
                  const result = await api.gitDiff(active);
                  setDiff({ label: 'diff HEAD', text: result.diff || 'No differences.' });
                }}
              >
                diff against HEAD
              </Button>
            }
          >
            {status.isLoading ? <LoadingRows rows={4} /> : null}
            {status.error ? <ErrorState title="Git state could not be read" detail={(status.error as Error).message} retry={() => void status.refetch()} /> : null}
            {status.data ? (
              <div className="space-y-2 px-3 py-2 text-[12px]">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-3.5 text-faint" />
                  <Mono className="text-ink">{status.data.branch}</Mono>
                  {status.data.clean ? <Badge tone="free">clean tree</Badge> : <Badge tone="warn">{status.data.entries.length} uncommitted</Badge>}
                  {status.data.operationInProgress ? <Badge tone="danger">{status.data.operationInProgress} in progress</Badge> : null}
                  {status.data.ahead || status.data.behind ? (
                    <span className="text-[11px] text-faint">
                      {status.data.ahead} ahead, {status.data.behind} behind {status.data.upstream ?? ''}
                    </span>
                  ) : null}
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Changes</div>
                  <ul className="space-y-0.5">
                    {status.data.entries.map((change) => (
                      <li key={change.path} className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="truncate text-left text-accent hover:underline"
                          onClick={async () => {
                            const result = await api.gitDiff(active, { path: change.path });
                            setDiff({ label: `diff ${change.path}`, text: result.diff || 'No differences for this path (an untracked file has nothing to diff against).' });
                          }}
                        >
                          {change.path}
                        </button>
                        <span className="flex shrink-0 items-center gap-1">
                          {change.conflicted ? <Badge tone="danger">conflict</Badge> : null}
                          {change.untracked ? <Badge tone="neutral">new</Badge> : null}
                          <Mono>{change.code.trim()}</Mono>
                        </span>
                      </li>
                    ))}
                    {status.data.entries.length === 0 ? <li className="text-muted">Nothing uncommitted.</li> : null}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Branches</div>
                  <ul className="space-y-0.5">
                    {status.data.branches.map((branch) => (
                      <li key={branch.name} className="flex items-center justify-between gap-2">
                        <Mono className={branch.current ? 'text-ink' : undefined}>{branch.name}</Mono>
                        {branch.current ? (
                          <Badge tone="accent">current</Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setMergeResult(null);
                              setMergeBranch(branch.name);
                            }}
                            title="Merge this branch into the current one"
                          >
                            merge
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
          </Section>

          <Section title="Commits" className="lg:col-span-2" actions={<Mono>{log.data?.commits.length ?? 0} in history</Mono>}>
            {log.isLoading ? <LoadingRows rows={8} /> : null}
            {log.data ? (
              <>
                {log.data.byAgent.length ? (
                  <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-1.5">
                    {log.data.byAgent.map((entry) => (
                      <Badge key={entry.agentId ?? 'system'} tone="neutral">
                        {entry.agentId ?? 'system'}: {entry.commits}
                        {entry.insertions !== undefined ? ` · +${entry.insertions}/-${entry.deletions ?? 0}` : ''}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Sha</th>
                      <th>Message</th>
                      <th>Author</th>
                      <th>When</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {log.data.commits.map((commit) => (
                      <tr key={commit.sha} className="row-hover">
                        <td>
                          <Mono>{commit.sha.slice(0, 8)}</Mono>
                        </td>
                        <td className="max-w-[420px] truncate">{commit.message}</td>
                        <td title={commit.authorEmail}>
                          {commit.authorName}
                        </td>
                        <td title={formatDateTime(commit.committedAt)}>
                          <TimeAgo iso={commit.committedAt} />
                        </td>
                        <td className="text-right">
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              const result = await api.gitDiff(active, { from: `${commit.sha}^`, to: commit.sha });
                              setDiff({ label: `diff ${commit.sha.slice(0, 8)}`, text: result.diff || 'No differences (initial commit).' });
                            }}
                          >
                            diff
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {log.data.commits.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-muted">
                          No commits yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                {log.data.recorded.length ? (
                  <div className="border-t border-line px-3 py-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Commits recorded against agents</div>
                    <ul className="space-y-0.5 text-[11px]">
                      {log.data.recorded.slice(0, 10).map((entry) => (
                        <li key={entry.sha} className="flex items-center gap-2">
                          <Mono>{entry.sha.slice(0, 8)}</Mono>
                          {entry.agentId ? <AgentLink agentId={entry.agentId} /> : <span className="text-faint">system</span>}
                          <span className="truncate text-muted">{entry.message}</span>
                          {entry.filesChanged ? (
                            <span className="shrink-0 text-faint">
                              {entry.filesChanged} file{entry.filesChanged === 1 ? '' : 's'} · +{entry.insertions}/-{entry.deletions}
                            </span>
                          ) : null}
                          <span className="ml-auto shrink-0 text-faint">{entry.branch}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}
          </Section>

          <div className="lg:col-span-3">
            <Link to={`/projects/${active}/git`} className="text-[11px] text-accent hover:underline">
              open this project's Git tab (with per-task context) →
            </Link>
          </div>
        </div>
      ) : null}

      <Modal open={Boolean(diff)} title={diff?.label ?? 'diff'} onClose={() => setDiff(null)} width="lg">
        <pre className="max-h-[70vh] overflow-auto whitespace-pre text-[11px] leading-4">{diff?.text}</pre>
      </Modal>

      <Modal
        open={Boolean(mergeBranch)}
        title={`Merge ${mergeBranch ?? ''}`}
        onClose={() => {
          setMergeBranch(null);
          setMergeResult(null);
        }}
        width="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setMergeBranch(null);
                setMergeResult(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<GitMerge className="size-3.5" />}
              onClick={async () => {
                if (!mergeBranch || !active) return;
                try {
                  const result = await api.gitMerge(active, { from: mergeBranch });
                  setMergeResult(
                    result.conflicts?.length
                      ? `Merge stopped with conflicts in ${result.conflicts.length} file(s): ${result.conflicts.join(', ')}. Nothing was resolved automatically — resolve them in the workspace and commit.`
                      : `Merged ${mergeBranch}${result.sha ? ` as ${result.sha.slice(0, 8)}` : ''}.`,
                  );
                } catch (err) {
                  setMergeResult(err instanceof Error ? err.message : String(err));
                } finally {
                  setMergeBranch(null);
                  await status.refetch();
                  await log.refetch();
                }
              }}
            >
              Merge into current branch
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-muted">
          The branch is merged into the currently checked-out branch of the project repository. If the merge conflicts, it is left for you to resolve: the orchestrator does not guess how to
          combine two agents' edits.
        </p>
      </Modal>

      {mergeResult ? (
        <div className={cx('mt-3 rounded-[var(--radius-md)] border px-3 py-2 text-[12px]', mergeResult.includes('conflict') ? 'border-warn/40 bg-warn/5 text-warn' : 'border-line bg-surface-2 text-muted')}>
          {mergeResult}
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setMergeResult(null)}>
            dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
