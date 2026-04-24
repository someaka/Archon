export interface CredentialCheck {
  hasClaudeCredentials: boolean;
  hasCodexCredentials: boolean;
  hasHermesCredentials: boolean;
  hasAnyCredentials: boolean;
}

export function validateAiCredentials(env: NodeJS.ProcessEnv): CredentialCheck {
  const hasClaudeCredentials = Boolean(
    env.CLAUDE_API_KEY?.trim() ||
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env.CLAUDE_USE_GLOBAL_AUTH?.trim()
  );
  const hasCodexCredentials = Boolean(env.CODEX_ID_TOKEN?.trim() && env.CODEX_ACCESS_TOKEN?.trim());
  const hasHermesCredentials = Boolean(
    env.HERMES_MODEL?.trim() || env.HERMES_BINARY_PATH?.trim() || env.HERMES_API_KEY?.trim()
  );

  return {
    hasClaudeCredentials,
    hasCodexCredentials,
    hasHermesCredentials,
    hasAnyCredentials: hasClaudeCredentials || hasCodexCredentials || hasHermesCredentials,
  };
}
