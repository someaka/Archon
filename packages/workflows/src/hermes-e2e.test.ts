/**
 * Hermes E2E test — exercises executeWorkflow() with provider: hermes.
 *
 * This file mocks ./dag-executor. Because executor.test.ts also mocks
 * ./dag-executor, these tests MUST run in a separate `bun test` invocation.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

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
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
}));

// --- Mock git ---
mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
const mockExecuteDagWorkflow = mock(async (): Promise<string | undefined> => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// --- Mock logger functions ---
mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

// --- Mock event emitter ---
const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Imports after mocks ---
import { executeWorkflow } from './executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    updateWorkflowActivity: mock(async () => {}),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    completeWorkflowRun: mock(async () => {}),
    pauseWorkflowRun: mock(async () => {}),
    cancelWorkflowRun: mock(async () => {}),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(async () => {}),
    emitRetract: mock(async () => {}),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: {
          claude: {},
          codex: {},
          hermes: {},
        },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'hermes-test-workflow',
    description: 'Hermes E2E test workflow',
    nodes: [{ id: 'node1', prompt: 'Do something with Hermes' }],
    provider: 'hermes',
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'hermes-test-workflow',
    conversation_id: 'conv-1',
    status: 'running',
    started_at: new Date().toISOString() as unknown as Date,
    metadata: {},
    ...overrides,
  } as WorkflowRun;
}

// --- Tests ---

describe('Hermes E2E workflow execution', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  it('executes a workflow with provider: hermes through executeWorkflow', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    const platform = makePlatform();
    const workflow = makeWorkflow();

    const result = await executeWorkflow(
      deps,
      platform,
      'conv-1',
      '/tmp',
      workflow,
      'test message',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
  });
});
