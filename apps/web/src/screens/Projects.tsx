import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button, ErrorState, Input, LoadingRows, Modal, Panel, Select } from '@aido/ui';
import { useCreateProject, useProjects } from '../lib/api.js';
import { PageHeader, ProjectStatusBadge, TimeAgo } from '../components/common.js';
import { formatNumber } from '@aido/ui';

/**
 * Projects: the entry point to the whole product. Creating one is a form with the goal
 * and the engineering constraints, because that is what the Architect actually needs —
 * a "name and go" wizard would produce plans nobody asked for.
 */
export function Projects(): ReactNode {
  const projects = useProjects();
  const create = useCreateProject();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(params.get('new') === '1');

  useEffect(() => {
    if (params.get('new') === '1') setOpen(true);
  }, [params]);

  const close = (): void => {
    setOpen(false);
    params.delete('new');
    setParams(params, { replace: true });
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Projects"
        subtitle="Each project gets its own workspace, Git repository and agent team."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setOpen(true)}>
            New project
          </Button>
        }
      />

      {projects.isLoading ? <LoadingRows rows={5} /> : null}
      {projects.error ? <ErrorState title="Projects could not be loaded" detail={(projects.error as Error).message} retry={() => void projects.refetch()} /> : null}

      {projects.data && projects.data.length === 0 ? (
        <Panel className="p-6 text-center">
          <div className="text-[13px] font-medium">No projects yet</div>
          <p className="mx-auto mt-1 max-w-xl text-[12px] text-muted">
            A project is a real repository: the team plans tasks, writes files, runs tests and commits on per-agent branches. Create one with a goal and the stack you want.
          </p>
          <Button className="mt-3" variant="primary" onClick={() => setOpen(true)}>
            Create the first project
          </Button>
        </Panel>
      ) : null}

      {projects.data && projects.data.length > 0 ? (
        <Panel>
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Status</th>
                <th>Run</th>
                <th>Tasks</th>
                <th>Branch</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.data.map((project) => {
                const counts = (project.counts ?? {}) as Record<string, number>;
                const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
                return (
                  <tr key={project.id} className="row-hover">
                    <td className="max-w-[360px]">
                      <Link to={`/projects/${project.id}`} className="text-ink hover:text-accent">
                        {project.name}
                      </Link>
                      <div className="truncate text-[11px] text-faint">{project.spec?.goal ?? project.description ?? 'no goal recorded'}</div>
                    </td>
                    <td>
                      <ProjectStatusBadge status={project.status} />
                    </td>
                    <td>{project.run?.running ? <span className="text-free">running</span> : project.run?.paused ? 'paused' : 'idle'}</td>
                    <td className="tabular">
                      {counts.done ?? 0}/{total || '—'}
                      {counts.failed ? <span className="ml-1 text-danger">({counts.failed} failed)</span> : null}
                    </td>
                    <td className="tabular">{project.branch}</td>
                    <td>
                      <TimeAgo iso={project.updatedAt} />
                    </td>
                    <td className="text-right">
                      <Button onClick={() => navigate(`/projects/${project.id}`)}>open</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <Modal
        open={open}
        title="New project"
        onClose={close}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() => {
                const form = document.getElementById('new-project-form') as HTMLFormElement | null;
                if (!form) return;
                const data = new FormData(form);
                const goal = String(data.get('goal') ?? '').trim();
                const name = String(data.get('name') ?? '').trim();
                if (!name || !goal) return;
                create.mutate(
                  {
                    name,
                    description: String(data.get('description') ?? ''),
                    sourceRepo: String(data.get('sourceRepo') ?? '').trim() || undefined,
                    spec: {
                      goal,
                      description: String(data.get('description') ?? ''),
                      techStack: String(data.get('techStack') ?? '')
                        .split(',')
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                      constraints: String(data.get('constraints') ?? '')
                        .split('\n')
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                      nonFunctional: [],
                      acceptanceCriteria: String(data.get('acceptanceCriteria') ?? '')
                        .split('\n')
                        .map((entry) => entry.trim())
                        .filter(Boolean),
                      targetUsers: String(data.get('targetUsers') ?? ''),
                      deliverable: String(data.get('deliverable') ?? ''),
                    },
                  },
                  {
                    onSuccess: (project) => {
                      close();
                      navigate(`/projects/${project.id}`);
                    },
                  },
                );
              }}
            >
              Create project
            </Button>
          </>
        }
      >
        <form id="new-project-form" className="space-y-2.5" onSubmit={(event) => event.preventDefault()}>
          <Field label="Name" hint="Used for the workspace directory and the slug.">
            <Input name="name" placeholder="Docs search CLI" required maxLength={120} />
          </Field>
          <Field label="Goal" hint="What should exist when the team is finished? This is what the Architect plans from.">
            <textarea
              name="goal"
              required
              rows={3}
              maxLength={4_000}
              placeholder="Build a CLI that searches a directory of Markdown files and prints matching sections with file and line numbers."
              className="w-full rounded-[var(--radius-sm)] border border-line bg-inset px-2 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
            />
          </Field>
          <div className="grid gap-2.5 md:grid-cols-2">
            <Field label="Tech stack" hint="Comma separated. Leave empty to let the Architect choose.">
              <Input name="techStack" placeholder="TypeScript, Node 22, no runtime deps" />
            </Field>
            <Field label="Existing repository (optional)" hint="A Git URL to clone into the workspace.">
              <Input name="sourceRepo" placeholder="https://github.com/org/repo.git" />
            </Field>
          </div>
          <Field label="Constraints" hint="One per line: things the team must not do.">
            <textarea
              name="constraints"
              rows={2}
              className="w-full rounded-[var(--radius-sm)] border border-line bg-inset px-2 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
              placeholder={'No network calls at runtime\nMust run on Node 22 without build step'}
            />
          </Field>
          <Field label="Acceptance criteria" hint="One per line. QA writes tests against these.">
            <textarea
              name="acceptanceCriteria"
              rows={2}
              className="w-full rounded-[var(--radius-sm)] border border-line bg-inset px-2 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
              placeholder={'Searching returns file and line for each hit\nNon-zero exit code when nothing matches'}
            />
          </Field>
          {create.error ? <ErrorState title="The project could not be created" detail={(create.error as Error).message} /> : null}
          <p className="text-[11px] text-faint">
            The project is created with a Git repository and a <span className="tabular">main</span> branch. Nothing runs until you press Run.
          </p>
        </form>
      </Modal>
    </div>
  );
}

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[11px] text-faint">{hint}</span> : null}
    </label>
  );
}
