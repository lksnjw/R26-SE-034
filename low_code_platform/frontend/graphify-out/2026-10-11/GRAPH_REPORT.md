# Graph Report - frontend  (2026-10-11)

## Corpus Check
- 495 files · ~175,737 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1671 nodes · 3809 edges · 155 communities (126 shown, 29 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `05451d17`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Card.jsx
- AuthContext.jsx
- router.jsx
- ExecutionDetailPage.jsx
- ChatMessage.jsx
- devDependencies
- dependencies
- WorkflowBuilderCanvas.jsx
- apiClient
- useAuthContext
- WorkflowWorkspaceEditor
- ResourceState.jsx
- ProfilePage.jsx
- CompanyPage.jsx
- execution.service.js
- ProtectedPatchPreview.jsx
- UserListPage.jsx
- useNotifications
- useExecution.js
- nodes/index.js
- navigation.js
- PipelineUploadPage.jsx
- WorkflowWorkspaceEditor.test.jsx
- WorkflowRunReceipt.jsx
- workflow.service.js
- WorkflowSchedulePanel.jsx
- compilerOptions
- ExecutionReviewInboxPage.jsx
- App.jsx
- ConditionalEdge.jsx
- WorkflowWorkspaceCanvas.jsx
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
- protectedFlow.test.jsx
- MessageMarkdown.jsx
- McpConnectionPanel.jsx
- EmailDraftPreview.jsx
- run-admission.service.js
- usePermissions
- AgentNodeInspector.jsx
- ChatWindow.jsx
- ReadSimulationPanel.test.jsx
- ReadableValue.jsx
- ExecutionTable.jsx
- ReadSimulationPanel.jsx
- ReadValueFields.jsx
- CollectionFields.jsx
- ModelBranchInsertion.test.jsx
- SchemaFields.jsx
- Topbar.jsx
- scripts
- WorkflowWorkspaceEditor.jsx
- iterationEvidence.js
- apiErrorMessage
- OperationReconciliationReview.jsx
- ExecutionReviewInboxPage.test.jsx
- WorkflowEditHistory.jsx
- useChat.js
- ChatHistory.jsx
- ValueFields.jsx
- ChatPage.jsx
- permissionParity.test.jsx
- config/axios.js
- DatafeedPage.jsx
- useChat.test.jsx
- WorkflowListPage.jsx
- cron.utils.js
- DashboardPage.test.jsx
- RegistryBulkImportPanel.test.jsx
- mcp-connection.service.js
- package.json
- user.service.js
- Spinner.jsx
- protected-approval-review.test.js
- ConditionPatchPreview.test.jsx
- task-dashboard.service.js
- permission.utils.js
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
- executionService
- analytics.service.js

## God Nodes (most connected - your core abstractions)
1. `usePermissions()` - 57 edges
2. `apiClient` - 51 edges
3. `apiErrorMessage()` - 45 edges
4. `Card()` - 37 edges
5. `useAuthContext()` - 36 edges
6. `executionService` - 34 edges
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
- `RegisterPage()` --calls--> `useAuthContext()`  [EXTRACTED]
  src/pages/auth/RegisterPage.jsx → src/context/AuthContext.jsx

## Import Cycles
- None detected.

## Communities (155 total, 29 thin omitted)

### Community 0 - "Card.jsx"
Cohesion: 0.08
Nodes (22): BarChart(), DonutChart(), F1ScoreGauge(), HealingSuccessRate(), HeatmapCalendar(), LineChart(), MetricCard(), UsageTrendCard() (+14 more)

### Community 1 - "AuthContext.jsx"
Cohesion: 0.15
Nodes (7): AuthStateProbe(), getRefreshInFlight(), AuthContext, AuthProvider(), loadCurrentUser(), loadStoredUser(), authService

### Community 2 - "router.jsx"
Cohesion: 0.12
Nodes (11): EmptyState(), allProtectedRouteDefinitions, AppShell(), authPaths, navigationRouteIds, protectedChildren, ProtectedScreen(), PublicScreen() (+3 more)

### Community 3 - "ExecutionDetailPage.jsx"
Cohesion: 0.05
Nodes (46): DashboardTaskList(), taskStatus(), TaskCalendar(), policyFailure, toolFailure, ExecutionStatus(), icons, ExecutionTimeline() (+38 more)

### Community 4 - "ChatMessage.jsx"
Cohesion: 0.10
Nodes (10): CanvasHandoffButton(), handleClick(), ValidationBadge(), InlineSources(), InlineVisualisation(), PIE_COLORS, FlowPreviewCard(), workflowArtifactStatus() (+2 more)

### Community 5 - "devDependencies"
Cohesion: 0.09
Nodes (23): autoprefixer, @babel/core, @babel/preset-react, @eslint/js, eslint-plugin-react-hooks, globals, jest, jest-environment-jsdom (+15 more)

### Community 6 - "dependencies"
Cohesion: 0.08
Nodes (25): axios, @iconify/react, js-yaml, lucide-react, dependencies, axios, @iconify/react, js-yaml (+17 more)

### Community 7 - "WorkflowBuilderCanvas.jsx"
Cohesion: 0.05
Nodes (53): BuilderModeControls(), getInitialCanvasState(), WorkflowBuilderCanvas(), WorkflowBuilderSurface(), BuilderSidebar(), iconMap, statusMeta, toneClasses (+45 more)

### Community 8 - "apiClient"
Cohesion: 0.18
Nodes (10): apiClient, unwrap(), auditService, capabilityService, icons, tones, integrationService, notificationService (+2 more)

### Community 9 - "useAuthContext"
Cohesion: 0.23
Nodes (6): ServerUnreachableBanner(), AuthenticatedRoute(), useAuthContext(), WorkspaceLayout(), LoginPage(), SecurityPage()

### Community 10 - "WorkflowWorkspaceEditor"
Cohesion: 0.18
Nodes (15): canPlaceNode(), flowPlacementModel(), insertionPlacementPreview(), insertionPositionValue(), invalid(), movePlacementPreview(), nodeID(), flow (+7 more)

### Community 11 - "ResourceState.jsx"
Cohesion: 0.12
Nodes (13): RegistryGenerationContextViewer(), RegistryStatusBanner(), EmptyState(), ErrorState(), LoadingState(), RegistryImportPage(), REVIEW_GROUPS, NEW_RULE (+5 more)

### Community 12 - "ProfilePage.jsx"
Cohesion: 0.18
Nodes (4): Avatar(), initials(), ProfilePage(), profileService

### Community 13 - "CompanyPage.jsx"
Cohesion: 0.13
Nodes (16): FormField(), Textarea(), ApprovalTiersTab(), CompanyPage(), CostCentresTab(), DepartmentsTab(), EMPTY_APPROVAL_TIER, EMPTY_COST_CENTRE (+8 more)

### Community 14 - "execution.service.js"
Cohesion: 0.22
Nodes (9): initial(), formatDuration(), formatTokens(), normalizeExecution(), reconciliationDate(), reconciliationExact(), reconciliationId(), reconciliationOutcomes (+1 more)

### Community 15 - "ProtectedPatchPreview.jsx"
Cohesion: 0.17
Nodes (13): CollectionPatchPreview(), summary(), ConditionPatchPreview(), summary(), ProtectedPatchPreview(), summary(), before, output (+5 more)

### Community 16 - "UserListPage.jsx"
Cohesion: 0.12
Nodes (14): Checkbox(), Input(), Select(), PermissionMatrix(), restrictPermissionsToCaller(), RoleCreateForm(), BUILT_IN_ROLE_IDS, RolePermissionEditor() (+6 more)

### Community 17 - "useNotifications"
Cohesion: 0.11
Nodes (19): ApiKeyCard(), IntegrationCard(), LlmModelSelector(), WebhookForm(), CopyButton(), Toggle(), NotificationContext, NotificationProvider() (+11 more)

### Community 18 - "useExecution.js"
Cohesion: 0.31
Nodes (7): useExecution(), useExecutionMonitor(), ExecutionLogsPage(), eventNames, executionEventLabel(), isActiveExecution(), reconcileExecutionEvents()

### Community 20 - "navigation.js"
Cohesion: 0.12
Nodes (17): features, disabledPaths, hasAnyFor(), ROLE_IDS, ROLES, routeByPath, visibleNavEntries(), appRouteObjects (+9 more)

### Community 21 - "PipelineUploadPage.jsx"
Cohesion: 0.13
Nodes (6): CsvUploadCard(), DOCUMENT_TYPES, DocumentUploadCard(), SENSITIVITY_LEVELS, pipelineService, TERMINAL_JOB_STATES

### Community 22 - "WorkflowWorkspaceEditor.test.jsx"
Cohesion: 0.05
Nodes (36): asset, manifest, shell, conditionFlow, messages, proposal, protectedChatRecord(), protectedRecord() (+28 more)

### Community 23 - "WorkflowRunReceipt.jsx"
Cohesion: 0.21
Nodes (10): WorkflowRunReceipt(), empty, run, useRunAdmissionRecovery(), canDismissRecordedRun(), empty, receipt, useWorkflowDetailRun() (+2 more)

### Community 24 - "workflow.service.js"
Cohesion: 0.25
Nodes (4): notify, formatRelativeTime(), dashboardService, normalizeWorkflow()

### Community 25 - "WorkflowSchedulePanel.jsx"
Cohesion: 0.10
Nodes (27): cadenceLabel(), defaultForm(), defaultZone(), emptyWindowBinding(), format(), periodByCadence, savedForm(), binding (+19 more)

### Community 26 - "compilerOptions"
Cohesion: 0.33
Nodes (5): compilerOptions, baseUrl, paths, include, src

### Community 27 - "ExecutionReviewInboxPage.jsx"
Cohesion: 0.27
Nodes (8): ExecutionReviewInboxPage(), InboxContent(), bounded(), getReviewInbox(), kinds, row, validateReviewInbox(), validDate()

### Community 28 - "App.jsx"
Cohesion: 0.20
Nodes (5): App(), queryClient, ErrorBoundary, appRouter, ThemeProvider()

### Community 30 - "WorkflowWorkspaceCanvas.jsx"
Cohesion: 0.32
Nodes (8): selectedWorkflowChoice(), workflowChoices(), parseWorkflowPreview(), workflowArtifacts(), workflowSource(), ChatArtifactPanel, editorProps, WorkflowWorkspaceCanvas()

### Community 34 - "ChatArtifactPanel.jsx"
Cohesion: 0.16
Nodes (14): Collapsible(), METHOD_COLORS, Pill(), RISK_COLORS, SectionHeader(), ACTION_ICON, DECISION_COLORS, ExampleCard() (+6 more)

### Community 79 - "build-hosting.mjs"
Cohesion: 0.07
Nodes (31): artifactDir, base, bindings, config, env, frontendDir, manifest, repositoryDir (+23 more)

### Community 92 - "RuntimeApprovalPolicyPanel.jsx"
Cohesion: 0.10
Nodes (20): keyFor(), PolicyEditor(), PolicyWorkspace(), reload(), save(), restore(), RuntimeApprovalPolicyPanel(), clients (+12 more)

### Community 93 - "CapabilityReviewPanel.jsx"
Cohesion: 0.12
Nodes (23): CapabilityInspector(), CapabilityReviewPanel(), Fields(), fitsInspector(), fullyVisible(), label(), restoreDecision(), ReviewWorkspace() (+15 more)

### Community 94 - "protectedFlow.test.jsx"
Cohesion: 0.16
Nodes (13): flowLoops(), branchDestination(), ConditionFields(), flowConditions(), flowReturns(), same(), ScopeSelect(), source (+5 more)

### Community 95 - "MessageMarkdown.jsx"
Cohesion: 0.33
Nodes (9): CodeBlock(), InlineContent(), isTableSeparator(), looksLikeHtml(), MessageMarkdown(), parseInline(), parseTableRow(), tokenize() (+1 more)

### Community 96 - "McpConnectionPanel.jsx"
Cohesion: 0.15
Nodes (15): ConnectionWorkspace(), confirm(), run(), send(), keyFor(), McpConnectionPanel(), readable(), restore() (+7 more)

### Community 97 - "EmailDraftPreview.jsx"
Cohesion: 0.24
Nodes (7): EmailDraftPreview(), reasonLabels, reportLabels, draft, sendMessage, useAuth, useAuth()

### Community 98 - "run-admission.service.js"
Cohesion: 0.19
Nodes (10): AUTH_STORAGE, assertAccount(), identity(), locked(), read(), receipt(), recover(), run (+2 more)

### Community 99 - "usePermissions"
Cohesion: 0.22
Nodes (15): ChatArtifactPanel(), Breadcrumb(), CommandPalette(), MobileNav(), Sidebar(), filterNavigationGroups(), getNavigationGroup(), RouteContext (+7 more)

### Community 100 - "AgentNodeInspector.jsx"
Cohesion: 0.33
Nodes (7): AgentNodeInspector(), integer(), predicateType(), AnalysisNodeInspector(), number(), ModelInputFields(), safeName()

### Community 101 - "ChatWindow.jsx"
Cohesion: 0.16
Nodes (9): ChatMessage(), attempts, ChatOperationProgress(), stages, toolLabel(), CAPABILITIES, ChatWelcome(), QUICK_PROMPTS (+1 more)

### Community 102 - "ReadSimulationPanel.test.jsx"
Cohesion: 0.21
Nodes (8): loopRecord, loopResponse(), modelResponse(), protectedRecord, protectedResponse(), record, response(), steps

### Community 103 - "ReadableValue.jsx"
Cohesion: 0.35
Nodes (10): Attachment(), equivalentJSON(), inlineMediaTypes, label(), notice(), present(), ReadableResult(), ReadableValue() (+2 more)

### Community 104 - "ExecutionTable.jsx"
Cohesion: 0.38
Nodes (5): columns, ExecutionTable(), RecordedModelUsage(), RECORDED_USAGE_EXPLANATION, recordedModelUsage()

### Community 105 - "ReadSimulationPanel.jsx"
Cohesion: 0.23
Nodes (14): collectionOwners(), protectedSimulationBoundary(), protectedSimulationLabels, simulationFixturePayload(), validProtectedTraceEntry(), collectionOutcomes, message(), modelNode() (+6 more)

### Community 106 - "ReadValueFields.jsx"
Cohesion: 0.33
Nodes (9): initialSchema(), kindInitial(), literal(), ReadBindingFields(), ReadValueFields(), reference(), safeKey(), SchemaContractFields() (+1 more)

### Community 107 - "CollectionFields.jsx"
Cohesion: 0.29
Nodes (7): CollectionFields(), IterationFixturePicker(), config, inner, outer, CollectionInspector(), CollectionWrapForm()

### Community 108 - "ModelBranchInsertion.test.jsx"
Cohesion: 0.25
Nodes (3): cases, flow, record

### Community 109 - "SchemaFields.jsx"
Cohesion: 0.16
Nodes (13): compatible(), Field(), initial(), reference(), SchemaFields(), shape(), schema, sources (+5 more)

### Community 110 - "Topbar.jsx"
Cohesion: 0.19
Nodes (8): Topbar(), UserMenu(), appConfig, ThemeContext, useTheme(), useClickOutside(), AuthLayout(), RegisterPage()

### Community 111 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, build:hosting, demo:local, dev, lint, preview, test (+2 more)

### Community 112 - "WorkflowWorkspaceEditor.jsx"
Cohesion: 0.21
Nodes (10): isOperationProfile(), protectedChatUnavailable, protectedGroupPatchVersion, ProtectedGroupInspector(), ProtectedWrapForm(), PublishedWorkflowRunForm(), emptyTimeline, message() (+2 more)

### Community 113 - "iterationEvidence.js"
Cohesion: 0.09
Nodes (26): predicateLabel(), ReadFlowTree(), action(), collection(), flow, protectedFlow(), sequence(), steps (+18 more)

### Community 114 - "apiErrorMessage"
Cohesion: 0.13
Nodes (12): RegistryBulkImportPanel(), Button(), variants, Modal(), UserBadge(), user, UserRow(), TemplateCard() (+4 more)

### Community 115 - "OperationReconciliationReview.jsx"
Cohesion: 0.19
Nodes (8): OperationReconciliationReview(), execution, result, review, completeApprovalDisplay(), RuntimeApprovalReview(), receipt, view

### Community 116 - "ExecutionReviewInboxPage.test.jsx"
Cohesion: 0.25
Nodes (4): clients, getReviewInbox, item, user

### Community 117 - "WorkflowEditHistory.jsx"
Cohesion: 0.28
Nodes (7): errorText(), labels, entry, page, record, source, WorkflowEditHistory()

### Community 118 - "useChat.js"
Cohesion: 0.17
Nodes (10): isActiveChatOperation(), reconcileChatProgress(), useChatOperationMonitor(), createSession, messages, normalSend, record, chatService (+2 more)

### Community 119 - "ChatHistory.jsx"
Cohesion: 0.39
Nodes (4): ChatHistory(), ChatSessionItem(), useChatSessions(), ChatHistoryPage()

### Community 120 - "ValueFields.jsx"
Cohesion: 0.38
Nodes (4): defaults, Field(), kind(), ValueFields()

### Community 121 - "ChatPage.jsx"
Cohesion: 0.22
Nodes (17): SaveModifiedWorkflowButton(), ChatRequestRevision(), message, source, ChatWindow(), NodePrompt(), useChat(), ChatPage() (+9 more)

### Community 123 - "permissionParity.test.jsx"
Cohesion: 0.22
Nodes (7): notify, permissions, rebuild, registryCreate, registryLoad, registryStatus, registryUpdate

### Community 124 - "config/axios.js"
Cohesion: 0.12
Nodes (6): notify, notify, isNetworkError(), isServerUnavailable(), NON_REFRESHABLE, value

### Community 125 - "DatafeedPage.jsx"
Cohesion: 0.27
Nodes (7): useSemanticStatus(), DatafeedPage(), formatSeconds(), formatObject(), PipelineConfigPage(), VectorMetricsPage(), semanticService

### Community 127 - "WorkflowListPage.jsx"
Cohesion: 0.16
Nodes (11): ExecutionFilters(), HealingReport(), DataTable(), Tabs(), WorkflowFilters(), columns, WorkflowTable(), useDebounce() (+3 more)

### Community 128 - "cron.utils.js"
Cohesion: 0.29
Nodes (3): DEFAULT_FRIENDLY, WEEKDAY_LABELS, WEEKDAY_NAMES

### Community 129 - "DashboardPage.test.jsx"
Cohesion: 0.47
Nodes (5): auth, clients, response(), setup(), task()

### Community 130 - "RegistryBulkImportPanel.test.jsx"
Cohesion: 0.40
Nodes (3): bulkImport, context, status

### Community 132 - "package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 133 - "user.service.js"
Cohesion: 0.70
Nodes (3): normalizeAdministrationUsers(), normalizePermissionMatrix(), normalizeUser()

### Community 135 - "protected-approval-review.test.js"
Cohesion: 0.29
Nodes (4): bounded(), date(), exact(), validProtectedApprovalReview()

### Community 139 - "permission.utils.js"
Cohesion: 0.38
Nodes (3): hasAnyPermission(), hasPermission(), resolveRouteComponent()

### Community 153 - "executionService"
Cohesion: 0.13
Nodes (9): ExecutionRunControls(), run, useExecution, clients, permissions, view, observation, queryRecord (+1 more)

## Knowledge Gaps
- **298 isolated node(s):** `baseUrl`, `paths`, `src`, `name`, `private` (+293 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **29 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `usePermissions()` connect `usePermissions` to `McpConnectionPanel.jsx`, `Card.jsx`, `ChatArtifactPanel.jsx`, `router.jsx`, `ExecutionDetailPage.jsx`, `useAuthContext`, `permission.utils.js`, `ResourceState.jsx`, `CompanyPage.jsx`, `UserListPage.jsx`, `iterationEvidence.js`, `apiErrorMessage`, `DatafeedPage.jsx`, `RuntimeApprovalPolicyPanel.jsx`, `CapabilityReviewPanel.jsx`, `WorkflowListPage.jsx`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `apiClient` connect `apiClient` to `AuthContext.jsx`, `DashboardPage.test.jsx`, `mcp-connection.service.js`, `ExecutionDetailPage.jsx`, `user.service.js`, `protected-approval-review.test.js`, `refreshRotation.test.js`, `task-dashboard.service.js`, `execution.service.js`, `useNotifications`, `WorkflowWorkspaceEditor.test.jsx`, `workflow.service.js`, `executionService`, `analytics.service.js`, `ExecutionReviewInboxPage.jsx`, `WorkflowSchedulePanel.jsx`, `RuntimeApprovalPolicyPanel.jsx`, `run-admission.service.js`, `Topbar.jsx`, `useChat.js`, `permissionParity.test.jsx`, `config/axios.js`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `ReadableValue()` connect `ReadableValue.jsx` to `ChatArtifactPanel.jsx`, `ExecutionDetailPage.jsx`, `AgentNodeInspector.jsx`, `ChatMessage.jsx`, `WorkflowBuilderCanvas.jsx`, `ReadSimulationPanel.jsx`, `ReadValueFields.jsx`, `CollectionFields.jsx`, `SchemaFields.jsx`, `ProtectedPatchPreview.jsx`, `WorkflowWorkspaceEditor.jsx`, `iterationEvidence.js`, `OperationReconciliationReview.jsx`, `WorkflowEditHistory.jsx`, `ValueFields.jsx`, `WorkflowWorkspaceCanvas.jsx`, `MessageMarkdown.jsx`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `baseUrl`, `paths`, `src` to the rest of the system?**
  _298 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Card.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08163265306122448 - nodes in this community are weakly interconnected._
- **Should `router.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.11594202898550725 - nodes in this community are weakly interconnected._
- **Should `ExecutionDetailPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.052289815447710185 - nodes in this community are weakly interconnected._