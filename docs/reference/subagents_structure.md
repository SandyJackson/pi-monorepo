Here's a comprehensive explanation of the sub-agents module with UML diagrams:

---

# Sub-Agents Module Architecture

## Overview

The sub-agents module enables Pi to delegate work to visible, interactive child agents that run in separate terminal panes. It follows a clean port-and-adapter architecture: the runner owns orchestration logic, while backends (like Herdr) handle runtime-specific spawning.

---

## Package Structure

```
packages/
├── herdr-contract/      # Shared event types (blocked state)
├── herdr-subagent/      # Main sub-agent extension
│   ├── index.ts         # Extension entrypoint
│   ├── agents.ts        # Agent discovery & config parsing
│   ├── subagent-runner.ts  # Backend-neutral orchestration
│   ├── herdr-backend.ts # Herdr-specific implementation
│   └── pi-session.ts    # Session file parsing
└── herdr-bridge/        # Herdr event bridge (separate)
```

---

## Class & Interface Diagram

```mermaid
classDiagram
    direction TB

    class ExtensionAPI {
        <<Pi SDK>>
        +on(event, handler)
        +registerTool(tool)
    }

    class ExtensionContext {
        <<Pi SDK>>
        +cwd: string
        +isProjectTrusted(): boolean
    }

    class AgentConfig {
        +name: string
        +description: string
        +tools?: string[]
        +model?: string
        +systemPromptBody: string
        +source: "user" | "project"
        +sourceDir: string
        +filePath: string
    }

    class SubagentInvocation {
        +invocationId: string
        +agentName: string
        +task: string
        +cwd: string
        +config: AgentConfig
    }

    class SpawnedSubagent {
        +id: string
        +displayTarget: string
        +label: string
        +cleanup(): void
        +markPromptConsumed?(): void
    }

    class SubagentOutcome {
        <<union>>
        reason: "completed" | "target_closed" | "aborted" | "timeout"
        answerText?: string
        fallbackText?: string
    }

    class SubagentBackend {
        <<interface>>
        +spawnBatch(invocations, options): SpawnBatchResult
        +waitForCompletion(spawned, options): SubagentOutcome
    }

    class HerdrBackend {
        -env: HerdrEnv
        +fromEnv(): BackendSelection
        +spawnBatch(invocations, options): SpawnBatchResult
        +waitForCompletion(spawned, options): SubagentOutcome
        -rpcCall(method, params, timeout, signal): Promise
        -findOrCreateSubagentsTab(): Tab
        -spawnOne(invocation, paneId): SpawnedSubagent
    }

    class RunnerOptions {
        +parentCwd: string
        +includeProjectAgents: boolean
        +detectAutoBackend(): BackendSelection
    }

    class RunResult {
        +content: TextContent[]
        +details: Record
        +isError?: boolean
    }

    ExtensionAPI --> ExtensionContext : provides
    ExtensionAPI --> SubagentBackend : registers tool that uses
    HerdrBackend ..|> SubagentBackend : implements
    SubagentInvocation --> AgentConfig : contains
    SpawnedSubagent --> SubagentOutcome : produces
    RunnerOptions --> SubagentBackend : creates via detectAutoBackend
```

---

## Component Interaction Diagram

```mermaid
graph TB
    subgraph "Pi Host Process"
        User([User/Model])
        Tool[Subagent Tool]
        Runner[Subagent Runner]
        AgentDiscovery[Agent Discovery]
    end

    subgraph "Backend Layer"
        Backend[SubagentBackend]
        HerdrBackend[HerdrBackend]
    end

    subgraph "Herdr Runtime"
        Socket[Unix Socket]
        Pane[Terminal Pane]
        ChildPi[Child Pi Process]
    end

    subgraph "File System"
        UserAgents[~/.config/pi/agents/*.md]
        ProjectAgents[.pi/agents/*.md]
        TempFiles[/tmp/pi-subagent-*/]
        SessionFile[session.jsonl]
    end

    User -->|"subagent({tasks})"| Tool
    Tool --> Runner
    Runner --> AgentDiscovery
    AgentDiscovery --> UserAgents
    AgentDiscovery --> ProjectAgents
    Runner --> Backend
    Backend --> HerdrBackend
    HerdrBackend -->|"JSON-RPC"| Socket
    Socket --> Pane
    Pane --> ChildPi
    HerdrBackend -.->|"writes"| TempFiles
    HerdrBackend -.->|"reads"| SessionFile

    style Tool fill:#4a9eff,color:#fff
    style Runner fill:#7c4aff,color:#fff
    style HerdrBackend fill:#ff6b6b,color:#fff
```

---

## Agent Discovery Flow

```mermaid
flowchart TD
    Start([Discover Agents]) --> Scope{Scope?}
    
    Scope -->|user| UserDir[~/.config/pi/agents/]
    Scope -->|project| WalkDir[Walk up from cwd]
    Scope -->|both| Both[Search both]
    
    WalkDir --> FindDir{Found .pi/agents/?}
    FindDir -->|Yes| ProjectDir[Load from .pi/agents/]
    FindDir -->|No, root reached| Empty[Return empty]
    
    UserDir --> LoadMD[Load .md files]
    ProjectDir --> LoadMD
    
    LoadMD --> ParseFrontmatter[YAML Frontmatter]
    ParseFrontmatter --> Extract[Extract Config]
    
    Extract --> Name[name]
    Extract --> Desc[description]
    Extract --> Tools[tools allowlist]
    Extract --> Model[model override]
    Extract --> Body[system prompt body]
    
    Both --> Merge[Merge Lists]
    Merge --> Override[Project overrides User]
    Override --> Sort[Sort by name]
    
    style Start fill:#4a9eff,color:#fff
    style Sort fill:#22c55e,color:#fff
```

---

## Tool Execution Flow (Single Task)

```mermaid
sequenceDiagram
    participant M as Model
    participant T as Tool Handler
    participant R as Runner
    participant B as HerdrBackend
    participant H as Herdr Server
    participant P as Pane
    participant C as Child Pi

    M->>T: subagent({tasks: [{agent, task}]})
    T->>R: runSubagents(params)
    
    R->>R: Validate params
    R->>R: Resolve agent config
    
    R->>B: spawnBatch([invocation])
    B->>B: findOrCreateSubagentsTab()
    B->>H: tab.list / tab.create
    H-->>B: tab info
    
    B->>B: spawnOne(invocation, paneId)
    B->>B: Build argv (sanitize task)
    B->>H: agent.start({name, args})
    H->>P: Launch pi process
    P->>C: Start
    H-->>B: {pane_id}
    B-->>R: SpawnedSubagent
    
    R->>B: waitForCompletion(spawned)
    
    loop Polling
        B->>H: agent.get({target})
        H-->>B: {status, sessionPath}
        
        alt status == "working"
            B->>M: onUpdate("watching:working...")
        else status == "idle" || "done"
            B->>B: readSessionAnswer()
            B->>M: onUpdate("final answer captured")
        end
    end
    
    B-->>R: {reason: "completed", answerText}
    R-->>T: RunResult
    T-->>M: {content: [answer]}
```

---

## Parallel Execution Flow

```mermaid
flowchart LR
    subgraph "Batch 1 (max 4 concurrent)"
        T1[Task 1] --> Spawn1[Spawn]
        T2[Task 2] --> Spawn2[Spawn]
        T3[Task 3] --> Spawn3[Spawn]
    end
    
    subgraph "Wait"
        Spawn1 & Spawn2 & Spawn3 --> Wait[Promise.all]
    end
    
    subgraph "Batch 2"
        Wait --> T4[Task 4]
        T4 --> Spawn4[Spawn]
    end
    
    style Spawn1 fill:#4a9eff,color:#fff
    style Spawn2 fill:#4a9eff,color:#fff
    style Spawn3 fill:#4a9eff,color:#fff
    style Wait fill:#ff6b6b,color:#fff
```

**Key constraints:**
- `MAX_PARALLEL_TASKS = 8` (total tasks)
- `MAX_CONCURRENCY = 4` (concurrent waits)

---

## Backend Port (Adapter Pattern)

```mermaid
classDiagram
    class SubagentBackend {
        <<Port>>
        +spawnBatch(): SpawnBatchResult
        +waitForCompletion(): SubagentOutcome
    }
    
    class HerdrBackend {
        <<Adapter>>
        -env: HerdrEnv
        -rpcCall()
        -spawnOne()
    }
    
    class FutureBackend {
        <<Future>>
        +spawnBatch()
        +waitForCompletion()
    }
    
    class SpawnBatchResult {
        attempts: SpawnAttempt[]
    }
    
    class SpawnAttempt {
        <<union>>
        status: spawned | failed | not_started | indeterminate
    }
    
    SubagentBackend <|.. HerdrBackend
    SubagentBackend <|.. FutureBackend
    SpawnBatchResult --> SpawnAttempt
```

---

## Type Hierarchy

```mermaid
graph TD
    subgraph "Backend Types"
        SubagentBackend
        SpawnBatchResult
        SpawnAttempt
        SpawnBatchOptions
    end
    
    subgraph "Invocation Types"
        SubagentInvocation
        SpawnedSubagent
        WaitForCompletionOptions
    end
    
    subgraph "Outcome Types"
        SubagentOutcome
        RunResult
        BackendSelection
    end
    
    subgraph "Config Types"
        AgentConfig
        RunnerOptions
        AgentScope
    end
    
    SubagentBackend --> SpawnBatchResult
    SubagentBackend --> SubagentOutcome
    SpawnBatchResult --> SpawnAttempt
    SubagentInvocation --> AgentConfig
    SpawnedSubagent --> SubagentOutcome
    RunnerOptions --> SubagentBackend
    RunnerOptions --> AgentConfig
    
    style SubagentBackend fill:#4a9eff,color:#fff
    style SubagentOutcome fill:#22c55e,color:#fff
    style AgentConfig fill:#ff6b6b,color:#fff
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Port/Adapter pattern** | Allows swapping Herdr for tmux or other backends |
| **Session-scoped tool registration** | Description reflects current project trust & agents |
| **Task sanitization** | Herdr rejects control characters in arguments |
| **Batch spawning with concurrency cap** | Prevents overwhelming the system |
| **Stable settled polls** | Avoids premature completion on transient idle states |
| **Prompt file lifecycle** | Temp files cleaned after child confirms session |

---

Would you like me to dive deeper into any specific aspect, such as the error handling paths, the session polling mechanism, or how agent frontmatter is parsed?
