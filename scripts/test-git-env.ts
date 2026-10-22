// Git exports repository-local variables to hooks, e.g. GIT_DIR when pushing
// from a linked worktree. Tests run by pre-push would otherwise point their
// fixture Git commands at this repository. Names from `git rev-parse --local-env-vars`.
export const REPOSITORY_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

for (const name of REPOSITORY_GIT_ENV) delete process.env[name];
