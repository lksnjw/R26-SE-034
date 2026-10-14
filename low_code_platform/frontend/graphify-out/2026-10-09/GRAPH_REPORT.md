# Graph Report - frontend  (2026-10-09)

## Corpus Check
- 490 files · ~173,340 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1650 nodes · 3770 edges · 146 communities (120 shown, 26 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c4732388`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AnalyticsPage.jsx
- AuthContext.jsx
- router.jsx
- DashboardPage.jsx
- ChatMessage.jsx
- devDependencies
- dependencies
- WorkflowBuilderCanvas.jsx
- services/api.js
- useAuthContext
- WorkflowWorkspaceEditor.jsx
- RegistryPage.jsx
- CompanyPage.jsx
- execution.service.js
- ProtectedPatchPreview.jsx
- UserListPage.jsx
- apiErrorMessage
- useExecution.js
- nodes/index.js
- executionService
- PipelineUploadPage.jsx
- WorkflowWorkspaceEditor.test.jsx
- OperationReconciliationReview.jsx
- workflow.service.js
- WorkflowSchedulePanel.jsx
- compilerOptions
- execution-review.service.js
- App.jsx
- ConditionalEdge.jsx
- iterationEvidence.js
- ChatToolbar.jsx
- TableSkeleton.jsx
- ChatArtifactPanel.jsx
- flow.utils.js
- yaml.utils.js
- SuggestedPrompts.jsx
- themes.js
- i18n.js
- constants/api.js
- nodeTypes.js
- queryKeys.js
- build-hosting.mjs
- RuntimeApprovalPolicyPanel.jsx
- CapabilityReviewPanel.jsx
- WorkflowWorkspaceEditor
- McpConnectionPanel.jsx
- operation-recovery.service.js
- run-admission.service.js
- RouteContext.jsx
- AgentNodeInspector.jsx
- ChatWindow.jsx
- ReadSimulationPanel.test.jsx
- ReadableValue.jsx
- Card.jsx
- ReadSimulationPanel.jsx
- ReadValueFields.jsx
- ModelBranchInsertion.test.jsx
- SchemaFields.jsx
- LoginPage.jsx
- scripts
- EmailDraftPreview.jsx
- ReadFlowTree.test.jsx
- Button.jsx
- ChatPage.test.jsx
- ExecutionReviewInboxPage.test.jsx
- WorkflowWorkspaceCanvas.jsx
- ChatOperationProgress.jsx
- ChatPage.jsx
- config/axios.js
- writeWorkspaceValue
- navMatchesRoutePermissions.test.jsx
- DashboardPage.test.jsx
- user.service.js
- usePermissions
- useChat.test.jsx
- WorkflowListPage.jsx
- cron.utils.js
- mcp-connection.service.js
- ExecutionApprovalReviewPage.test.jsx
- package.json
- WorkflowRunReceipt.jsx
- task-dashboard.service.js
- permissionParity.test.jsx
- babel-jest
- CLAUDE.md
- eslint
- eslint-plugin-react-refresh
- prettier
- tailwindcss
- @testing-library/jest-dom
- @testing-library/react
- vite
- @vitejs/plugin-react
- Readme.md

## God Nodes (most connected - your core abstractions)
1. `usePermissions()` - 57 edges
2. `apiClient` - 50 edges
3. `apiErrorMessage()` - 45 edges
4. `Card()` - 37 edges
5. `useAuthContext()` - 36 edges
6. `executionService` - 33 edges
7. `LoadingState()` - 32 edges
8. `Button()` - 31 edges
9. `useNotifications()` - 31 edges
10. `ReadableValue()` - 30 edges

## Surprising Connections (you probably didn't know these)
- `hostingBindings()` --calls--> `createAppConfig()`  [EXTRACTED]
  scripts/hosting-config.mjs → src/config/endpoints.js
- `hostingBindings()` --calls--> `validateEndpoint()`  [EXTRACTED]
  scripts/hosting-config.mjs → src/config/endpoints.js
- `AuthStateProbe()` --calls--> `useAuthContext()`  [EXTRACTED]
  src/config/authRace.test.js → src/context/AuthContext.jsx
- `ProtectedScreen()` --calls--> `usePermissions()`  [EXTRACTED]
  src/config/router.jsx → src/hooks/usePermissions.js
- `AuthenticatedRoute()` --calls--> `useAuthContext()`  [EXTRACTED]
  src/config/router.jsx → src/context/AuthContext.jsx

## Import Cycles
- None detected.

## Communities (146 total, 26 thin omitted)

### Community 0 - "AnalyticsPage.jsx"
Cohesion: 0.13
Nodes (12): BarChart(), DonutChart(), F1ScoreGauge(), HealingSuccessRate(), HeatmapCalendar(), LineChart(), MetricCard(), UsageTrendCard() (+4 more)

### Community 1 - "AuthContext.jsx"
Cohesion: 0.12
Nodes (9): AuthStateProbe(), getRefreshInFlight(), isNetworkError(), isServerUnavailable(), AuthContext, AuthProvider(), loadCurrentUser(), loadStoredUser() (+1 more)

### Community 2 - "router.jsx"
Cohesion: 0.10
Nodes (14): EmptyState(), allProtectedRouteDefinitions, appRouteObjects, AppShell(), AuthenticatedRoute(), authPaths, lazyRouteComponents, navigationRouteIds (+6 more)

### Community 3 - "DashboardPage.jsx"
Cohesion: 0.10
Nodes (23): DashboardTaskList(), taskStatus(), TaskCalendar(), policyFailure, toolFailure, ExecutionStatus(), icons, GovernanceBlockPanel() (+15 more)

### Community 4 - "ChatMessage.jsx"
Cohesion: 0.10
Nodes (11): ChatArtifactPanel(), CanvasHandoffButton(), handleClick(), ValidationBadge(), InlineSources(), InlineVisualisation(), PIE_COLORS, FlowPreviewCard() (+3 more)

### Community 5 - "devDependencies"
Cohesion: 0.09
Nodes (23): autoprefixer, @babel/core, @babel/preset-react, @eslint/js, eslint-plugin-react-hooks, globals, jest, jest-environment-jsdom (+15 more)

### Community 6 - "dependencies"
Cohesion: 0.08
Nodes (25): axios, @iconify/react, js-yaml, lucide-react, dependencies, axios, @iconify/react, js-yaml (+17 more)

### Community 7 - "WorkflowBuilderCanvas.jsx"
Cohesion: 0.05
Nodes (53): BuilderModeControls(), getInitialCanvasState(), WorkflowBuilderCanvas(), WorkflowBuilderSurface(), BuilderSidebar(), iconMap, statusMeta, toneClasses (+45 more)

### Community 8 - "services/api.js"
Cohesion: 0.20
Nodes (9): apiClient, unwrap(), auditService, icons, tones, integrationService, profileService, synthesisService (+1 more)

### Community 9 - "useAuthContext"
Cohesion: 0.18
Nodes (12): Topbar(), UserMenu(), ServerUnreachableBanner(), useAuthContext(), ThemeContext, useTheme(), useClickOutside(), AppLayout() (+4 more)

### Community 10 - "WorkflowWorkspaceEditor.jsx"
Cohesion: 0.14
Nodes (18): canPlaceNode(), flowPlacementModel(), insertionPlacementPreview(), insertionPositionValue(), invalid(), movePlacementPreview(), nodeID(), flow (+10 more)

### Community 11 - "RegistryPage.jsx"
Cohesion: 0.09
Nodes (16): RegistryBulkImportPanel(), bulkImport, context, status, RegistryGenerationContextViewer(), RegistryStatusBanner(), Tabs(), RegistryContextPage() (+8 more)

### Community 13 - "CompanyPage.jsx"
Cohesion: 0.06
Nodes (19): FormField(), CodeBlock(), Spinner(), Textarea(), Toggle(), ApprovalTiersTab(), CompanyPage(), CostCentresTab() (+11 more)

### Community 14 - "execution.service.js"
Cohesion: 0.16
Nodes (14): columns, ExecutionTable(), RecordedModelUsage(), initial(), formatDuration(), formatTokens(), normalizeExecution(), reconciliationDate() (+6 more)

### Community 15 - "ProtectedPatchPreview.jsx"
Cohesion: 0.14
Nodes (15): CollectionPatchPreview(), summary(), ConditionPatchPreview(), summary(), before, merge, ProtectedPatchPreview(), summary() (+7 more)

### Community 16 - "UserListPage.jsx"
Cohesion: 0.10
Nodes (16): ExecutionFilters(), Checkbox(), Input(), Select(), PermissionMatrix(), restrictPermissionsToCaller(), RoleCreateForm(), BUILT_IN_ROLE_IDS (+8 more)

### Community 17 - "apiErrorMessage"
Cohesion: 0.13
Nodes (20): WebhookForm(), CopyButton(), PendingGenerationApprovalCard(), TemplateCard(), WorkflowActions(), WorkflowAssignments(), NotificationContext, NotificationProvider() (+12 more)

### Community 18 - "useExecution.js"
Cohesion: 0.19
Nodes (6): useExecution(), useExecutionMonitor(), ExecutionLogsPage(), eventNames, isActiveExecution(), reconcileExecutionEvents()

### Community 20 - "executionService"
Cohesion: 0.25
Nodes (7): ExecutionRunControls(), run, Receipt(), useExecution, executionService, executionEventLabel(), iterationPositionLabel()

### Community 21 - "PipelineUploadPage.jsx"
Cohesion: 0.13
Nodes (6): CsvUploadCard(), DOCUMENT_TYPES, DocumentUploadCard(), SENSITIVITY_LEVELS, pipelineService, TERMINAL_JOB_STATES

### Community 22 - "WorkflowWorkspaceEditor.test.jsx"
Cohesion: 0.06
Nodes (32): asset, manifest, shell, conditionFlow, messages, proposal, protectedChatRecord(), protectedRecord() (+24 more)

### Community 23 - "OperationReconciliationReview.jsx"
Cohesion: 0.16
Nodes (11): OperationReconciliationEvidence(), reconciliationOutcomeLabel(), OperationReconciliationReview(), execution, result, review, PendingApprovalCard(), completeApprovalDisplay() (+3 more)

### Community 24 - "workflow.service.js"
Cohesion: 0.25
Nodes (4): notify, formatRelativeTime(), dashboardService, normalizeWorkflow()

### Community 25 - "WorkflowSchedulePanel.jsx"
Cohesion: 0.10
Nodes (27): cadenceLabel(), defaultForm(), defaultZone(), emptyWindowBinding(), format(), periodByCadence, savedForm(), binding (+19 more)

### Community 26 - "compilerOptions"
Cohesion: 0.33
Nodes (5): compilerOptions, baseUrl, paths, include, src

### Community 27 - "execution-review.service.js"
Cohesion: 0.31
Nodes (7): InboxContent(), bounded(), getReviewInbox(), kinds, row, validateReviewInbox(), validDate()

### Community 28 - "App.jsx"
Cohesion: 0.22
Nodes (5): App(), queryClient, ErrorBoundary, appRouter, ThemeProvider()

### Community 30 - "iterationEvidence.js"
Cohesion: 0.23
Nodes (13): collectionRecord(), doneExecution, failedExecution, ExecutionOutputPanel(), fixture(), address(), failedModel(), iterationFixture() (+5 more)

### Community 34 - "ChatArtifactPanel.jsx"
Cohesion: 0.15
Nodes (15): Collapsible(), METHOD_COLORS, Pill(), RISK_COLORS, SectionHeader(), ACTION_ICON, DECISION_COLORS, ExampleCard() (+7 more)

### Community 79 - "build-hosting.mjs"
Cohesion: 0.08
Nodes (30): artifactDir, base, bindings, config, env, frontendDir, manifest, repositoryDir (+22 more)

### Community 92 - "RuntimeApprovalPolicyPanel.jsx"
Cohesion: 0.10
Nodes (20): keyFor(), PolicyEditor(), PolicyWorkspace(), reload(), save(), restore(), RuntimeApprovalPolicyPanel(), clients (+12 more)

### Community 93 - "CapabilityReviewPanel.jsx"
Cohesion: 0.12
Nodes (23): CapabilityInspector(), CapabilityReviewPanel(), Fields(), fitsInspector(), fullyVisible(), label(), restoreDecision(), ReviewWorkspace() (+15 more)

### Community 94 - "WorkflowWorkspaceEditor"
Cohesion: 0.12
Nodes (21): CollectionFields(), collectionOwners(), flowLoops(), IterationFixturePicker(), config, inner, outer, CollectionInspector() (+13 more)

### Community 96 - "McpConnectionPanel.jsx"
Cohesion: 0.16
Nodes (14): ConnectionWorkspace(), confirm(), run(), send(), keyFor(), readable(), restore(), streamHelp (+6 more)

### Community 97 - "operation-recovery.service.js"
Cohesion: 0.19
Nodes (14): OperationRecoveryArtifacts(), saved, source, artifact(), date(), deny(), exact(), history() (+6 more)

### Community 98 - "run-admission.service.js"
Cohesion: 0.19
Nodes (10): AUTH_STORAGE, assertAccount(), identity(), locked(), read(), receipt(), recover(), run (+2 more)

### Community 99 - "RouteContext.jsx"
Cohesion: 0.13
Nodes (22): Breadcrumb(), CommandPalette(), MobileNav(), Sidebar(), features, disabledPaths, protectedRouteDefinitions, allNavigationGroups (+14 more)

### Community 100 - "AgentNodeInspector.jsx"
Cohesion: 0.30
Nodes (8): AgentNodeInspector(), integer(), predicateType(), AnalysisNodeInspector(), number(), ModelInputFields(), safeName(), NodePrompt()

### Community 101 - "ChatWindow.jsx"
Cohesion: 0.22
Nodes (5): ChatMessage(), CAPABILITIES, ChatWelcome(), QUICK_PROMPTS, loadModels

### Community 102 - "ReadSimulationPanel.test.jsx"
Cohesion: 0.19
Nodes (9): ReadSimulationPanel(), loopRecord, loopResponse(), modelResponse(), protectedRecord, protectedResponse(), record, response() (+1 more)

### Community 103 - "ReadableValue.jsx"
Cohesion: 0.13
Nodes (23): CodeBlock(), InlineContent(), isTableSeparator(), looksLikeHtml(), MessageMarkdown(), parseInline(), parseTableRow(), tokenize() (+15 more)

### Community 104 - "Card.jsx"
Cohesion: 0.14
Nodes (13): ExecutionTimeline(), HealingReport(), LiveLogStream(), logLine(), ApiKeyCard(), IntegrationCard(), LlmModelSelector(), McpConnectionPanel() (+5 more)

### Community 105 - "ReadSimulationPanel.jsx"
Cohesion: 0.24
Nodes (13): protectedSimulationBoundary(), protectedSimulationLabels, simulationFixturePayload(), validProtectedTraceEntry(), collectionOutcomes, message(), modelNode(), modelOutcomes (+5 more)

### Community 106 - "ReadValueFields.jsx"
Cohesion: 0.21
Nodes (13): protectedChatUnavailable, protectedGroupPatchVersion, ProtectedGroupInspector(), ProtectedWrapForm(), initialSchema(), kindInitial(), literal(), ReadBindingFields() (+5 more)

### Community 108 - "ModelBranchInsertion.test.jsx"
Cohesion: 0.25
Nodes (3): cases, flow, record

### Community 109 - "SchemaFields.jsx"
Cohesion: 0.11
Nodes (19): isOperationProfile(), PublishedWorkflowRunForm(), compatible(), Field(), initial(), reference(), SchemaFields(), shape() (+11 more)

### Community 110 - "LoginPage.jsx"
Cohesion: 0.17
Nodes (4): appConfig, AuthLayout(), LoginPage(), RegisterPage()

### Community 111 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, build:hosting, demo:local, dev, lint, preview, test (+2 more)

### Community 112 - "EmailDraftPreview.jsx"
Cohesion: 0.24
Nodes (7): EmailDraftPreview(), reasonLabels, reportLabels, draft, sendMessage, useAuth, useAuth()

### Community 113 - "ReadFlowTree.test.jsx"
Cohesion: 0.31
Nodes (6): action(), collection(), flow, protectedFlow(), sequence(), steps

### Community 114 - "Button.jsx"
Cohesion: 0.15
Nodes (9): Avatar(), Button(), variants, Modal(), UserBadge(), user, UserRow(), initials() (+1 more)

### Community 115 - "ChatPage.test.jsx"
Cohesion: 0.32
Nodes (5): createSession, messages, normalSend, record, chatService

### Community 116 - "ExecutionReviewInboxPage.test.jsx"
Cohesion: 0.25
Nodes (4): clients, getReviewInbox, item, user

### Community 117 - "WorkflowWorkspaceCanvas.jsx"
Cohesion: 0.18
Nodes (14): selectedWorkflowChoice(), workflowChoices(), errorText(), labels, entry, page, record, source (+6 more)

### Community 118 - "ChatOperationProgress.jsx"
Cohesion: 0.21
Nodes (7): attempts, ChatOperationProgress(), stages, toolLabel(), isActiveChatOperation(), reconcileChatProgress(), useChatOperationMonitor()

### Community 119 - "ChatPage.jsx"
Cohesion: 0.29
Nodes (9): ChatHistory(), SaveModifiedWorkflowButton(), ChatSessionItem(), ChatWindow(), useChatSessions(), ChatHistoryPage(), ChatPage(), clearWorkflowForChatEdit() (+1 more)

### Community 120 - "config/axios.js"
Cohesion: 0.13
Nodes (7): notify, notify, NON_REFRESHABLE, capabilityService, observation, queryRecord, value

### Community 121 - "writeWorkspaceValue"
Cohesion: 0.23
Nodes (13): ChatRequestRevision(), message, source, useChat(), requireChatCapability(), requireChatReceipt(), acknowledgeChatCommand(), pending (+5 more)

### Community 122 - "navMatchesRoutePermissions.test.jsx"
Cohesion: 0.40
Nodes (5): hasAnyFor(), ROLE_IDS, ROLES, routeByPath, visibleNavEntries()

### Community 123 - "DashboardPage.test.jsx"
Cohesion: 0.47
Nodes (5): auth, clients, response(), setup(), task()

### Community 124 - "user.service.js"
Cohesion: 0.31
Nodes (5): AuditLogTable(), AuditPage(), normalizeAdministrationUsers(), normalizePermissionMatrix(), normalizeUser()

### Community 125 - "usePermissions"
Cohesion: 0.11
Nodes (20): OperationStatusQueries(), EmptyState(), ErrorState(), LoadingState(), usePermissions(), useSemanticStatus(), DatafeedPage(), formatSeconds() (+12 more)

### Community 127 - "WorkflowListPage.jsx"
Cohesion: 0.26
Nodes (7): DataTable(), columns, WorkflowTable(), useDebounce(), useWorkflows(), ExecutionListPage(), WorkflowListPage()

### Community 128 - "cron.utils.js"
Cohesion: 0.29
Nodes (3): DEFAULT_FRIENDLY, WEEKDAY_LABELS, WEEKDAY_NAMES

### Community 131 - "ExecutionApprovalReviewPage.test.jsx"
Cohesion: 0.40
Nodes (3): clients, permissions, view

### Community 132 - "package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 133 - "WorkflowRunReceipt.jsx"
Cohesion: 0.21
Nodes (10): WorkflowRunReceipt(), empty, run, useRunAdmissionRecovery(), canDismissRecordedRun(), empty, receipt, useWorkflowDetailRun() (+2 more)

### Community 135 - "permissionParity.test.jsx"
Cohesion: 0.22
Nodes (7): notify, permissions, rebuild, registryCreate, registryLoad, registryStatus, registryUpdate

## Knowledge Gaps
- **294 isolated node(s):** `baseUrl`, `paths`, `src`, `name`, `private` (+289 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `usePermissions()` connect `usePermissions` to `McpConnectionPanel.jsx`, `ChatArtifactPanel.jsx`, `RouteContext.jsx`, `ChatMessage.jsx`, `router.jsx`, `DashboardPage.jsx`, `Card.jsx`, `useAuthContext`, `RegistryPage.jsx`, `CompanyPage.jsx`, `UserListPage.jsx`, `apiErrorMessage`, `RuntimeApprovalPolicyPanel.jsx`, `CapabilityReviewPanel.jsx`, `WorkflowListPage.jsx`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `apiClient` connect `services/api.js` to `AuthContext.jsx`, `mcp-connection.service.js`, `task-dashboard.service.js`, `permissionParity.test.jsx`, `refreshRotation.test.js`, `useAuthContext`, `RegistryPage.jsx`, `execution.service.js`, `WorkflowWorkspaceEditor.test.jsx`, `workflow.service.js`, `WorkflowSchedulePanel.jsx`, `execution-review.service.js`, `RuntimeApprovalPolicyPanel.jsx`, `operation-recovery.service.js`, `run-admission.service.js`, `ChatPage.test.jsx`, `config/axios.js`, `DashboardPage.test.jsx`, `user.service.js`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `ReadableValue()` connect `ReadableValue.jsx` to `operation-recovery.service.js`, `ChatArtifactPanel.jsx`, `AgentNodeInspector.jsx`, `ChatMessage.jsx`, `WorkflowBuilderCanvas.jsx`, `ReadSimulationPanel.jsx`, `ReadValueFields.jsx`, `WorkflowWorkspaceEditor.jsx`, `SchemaFields.jsx`, `ProtectedPatchPreview.jsx`, `WorkflowWorkspaceCanvas.jsx`, `OperationReconciliationReview.jsx`, `WorkflowWorkspaceEditor`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `baseUrl`, `paths`, `src` to the rest of the system?**
  _294 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AnalyticsPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `AuthContext.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.11857707509881422 - nodes in this community are weakly interconnected._
- **Should `router.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.09788359788359788 - nodes in this community are weakly interconnected._