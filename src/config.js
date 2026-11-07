import path from 'node:path';

/** Resolves the runtime configuration from an env object (never read implicitly by library code). */
export function resolveConfig(env) {
  const projectsRoot = env.PROJECTS_ROOT;
  if (!projectsRoot) throw new Error('PROJECTS_ROOT is not set');
  return {
    projectsRoot,
    storeDir: path.join(projectsRoot, '.code-conductor'),
    conductorUrl: env.CONDUCTOR_URL ?? '',
  };
}
