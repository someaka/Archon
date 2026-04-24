import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock logger (MUST come before imports of modules under test) ---

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Imports (after mocks) ---
import { executeDagWorkflow } from './dag-executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

// --- Mock helpers ---

function createMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

const mockClaudeCapabilities = () => ({
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
});

const mockHermesCapabilities = () => ({
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: true,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: true,
  sandbox: false,
});

/** Per-provider mock sendQuery generators */
const mockClaudeSendQuery = mock(async function* () {
  yield { type: 'assistant' as const, content: 'Claude response' };
  yield { type: 'result' as const, sessionId: 'claude-session-id' };
});

const mockHermesSendQuery = mock(async function* () {
  yield { type: 'assistant' as const, content: 'Hermes response' };
  yield { type: 'result' as const, sessionId: 'hermes-session-id' };
});

/** getAgentProvider that returns different mocks per provider ID */
const mockGetAgentProvider = mock((provider: string) => {
  if (provider === 'hermes') {
    return {
      sendQuery: mockHermesSendQuery,
      getType: () => 'hermes',
      getCapabilities: mockHermesCapabilities,
    };
  }
  return {
    sendQuery: mockClaudeSendQuery,
    getType: () => 'claude',
    getCapabilities: mockClaudeCapabilities,
  };
});

function createMockDeps(storeOverride?: IWorkflowStore): WorkflowDeps {
  const store = storeOverride ?? createMockStore();
  return {
    store,
    getAgentProvider: mockGetAgentProvider,
    loadConfig: mock(() =>
      Promise.resolve({
        assistant: 'claude' as const,
        commands: { folder: '' },
        baseBranch: '',
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        assistants: { claude: {}, codex: {}, hermes: {} },
      })
    ),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'test message',
    metadata: {},
    started_at: new Date().toISOString(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    ...overrides,
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {}, hermes: {} },
  commands: { folder: '' },
  baseBranch: '',
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

// --- Tests ---

describe('Hermes integration — single-node workflow', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `hermes-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockClaudeSendQuery.mockClear();
    mockHermesSendQuery.mockClear();
    mockGetAgentProvider.mockClear();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('executes a single-node workflow with provider: hermes', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-test',
      testDir,
      {
        name: 'hermes-single',
        nodes: [{ id: 'analyze', command: 'my-cmd', provider: 'hermes' }],
      },
      workflowRun,
      'hermes',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'hermes' }
    );

    expect(mockGetAgentProvider).toHaveBeenCalledWith('hermes');
    expect(mockHermesSendQuery).toHaveBeenCalled();
    expect(mockClaudeSendQuery).not.toHaveBeenCalled();
  });
});

describe('Hermes integration — multi-provider workflow (Claude → Hermes)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `hermes-multi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockClaudeSendQuery.mockClear();
    mockHermesSendQuery.mockClear();
    mockGetAgentProvider.mockClear();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('calls getAgentProvider with correct IDs for each node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-test',
      testDir,
      {
        name: 'claude-to-hermes',
        nodes: [
          { id: 'plan', command: 'my-cmd', provider: 'claude' },
          { id: 'implement', command: 'my-cmd', depends_on: ['plan'], provider: 'hermes' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // getAgentProvider should be called for each AI node
    expect(mockGetAgentProvider).toHaveBeenCalledWith('claude');
    expect(mockGetAgentProvider).toHaveBeenCalledWith('hermes');

    // Both providers' sendQuery should have been invoked
    expect(mockClaudeSendQuery).toHaveBeenCalled();
    expect(mockHermesSendQuery).toHaveBeenCalled();
  });
});
