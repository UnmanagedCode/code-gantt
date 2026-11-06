import path from 'node:path';

/** Resolves the runtime configuration from an env object (never read implicitly by library code). */
export function resolveConfig(env) {
  const projectsRoot = env.PROJECTS_ROOT;
  if (!projectsRoot) throw new Error('PROJECTS_ROOT is not set');
  const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
  if (!dataDir) throw new Error('CONDUCTOR_PLUGIN_DATA_DIR is not set: this plugin writes only there and refuses to start without it');
  const claudeConfig = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? '', '.claude');
  return {
    projectsRoot,
    storeDir: path.join(projectsRoot, '.code-conductor'),
    transcriptRoot: env.CLAUDE_PROJECTS_ROOT ?? path.join(claudeConfig, 'projects'),
    dataDir,
    conductorUrl: env.CONDUCTOR_URL ?? '',
  };
}
