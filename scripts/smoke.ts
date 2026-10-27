import { GitLab, GlabTransport } from '../src/gitlab/client.js';
import { configuredHost } from '../src/config/host.js';
try {
  const host = configuredHost();
  const api = new GitLab(new GlabTransport(host));
  const projects = await api.projects();
  const project = projects.find(p => !p.empty && p.defaultBranch);
  if (project) {
    const { sha } = await api.head(project);
    const paths = await api.tree(project, sha);
    if (paths.length) await api.file(project, sha, paths[0]!);
  }
  console.log(JSON.stringify({ host, projects: projects.length, repositoryRead: !!project, status: 'ok' }));
} catch (error) {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : 'GitLab access failed'}`);
  process.exitCode = 1;
}
