# Graph Report - frontend  (2026-10-08)

## Corpus Check
- 483 files · ~166,753 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1616 nodes · 3669 edges · 151 communities (124 shown, 27 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `afa555dc`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AnalyticsPage.jsx
- Topbar.jsx
- router.jsx
- DashboardPage.jsx
- ChatMessage.jsx
- devDependencies
- dependencies
- WorkflowBuilderCanvas.jsx
- services/api.js
- Card.jsx
- FlowPlacementControls.jsx
- apiErrorMessage
- ResourceState.jsx
- CompanyPage.jsx
- execution.service.js
- ChatArtifactPanel.jsx
- ui/index.js
- useNotifications
- ExecutionRunControls.jsx
- nodes/index.js
- SettingsPage.jsx
- user.service.js
- WorkflowWorkspaceEditor.test.jsx
- executionService
- workflow.service.js
- WorkflowSchedulePanel.jsx
- compilerOptions
- execution-review.service.js
- WorkflowWorkspaceCanvas.jsx
- ConditionalEdge.jsx
- iterationEvidence.js
- ChatToolbar.jsx
- TableSkeleton.jsx
- Button.jsx
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
- WorkflowWorkspaceEditor.jsx
- DatafeedPage.jsx
- McpConnectionPanel.jsx
- operation-recovery.service.js
- run-admission.service.js
- usePermissions
- ReadValueFields.jsx
- ChatWindow.jsx
- ReadSimulationPanel.test.jsx
- ReadableValue.jsx
- CollectionPatchPreview.jsx
- CollectionFields.test.jsx
- useAuthContext
- DashboardPage.test.jsx
- ModelBranchInsertion.test.jsx
- SchemaFields.jsx
- AuthContext.jsx
- scripts
- EmailDraftPreview.jsx
- ReadFlowTree.jsx
- RolePermissionEditor.jsx
- config/axios.js
- ExecutionReviewInboxPage.test.jsx
- ExecutionDetailPage.jsx
- useChat.js
- ChatPage.jsx
- navMatchesRoutePermissions.test.jsx
- ReadSimulationPanel.jsx
- MessageMarkdown.jsx
- navigation.js
- AgentNodeInspector.jsx
- ReportPageResolutionReview.jsx
- useChat.test.jsx
- permission.utils.js
- cron.utils.js
- ValueFields.jsx
- execution-reconciliation.service.test.js
- WorkflowEditHistory.jsx
- package.json
- WorkflowRunReceipt.jsx
- McpConnectionPanel.test.jsx
- permissionParity.test.jsx
- ChatMessageVisualisation.jsx
- operation-recovery.service.test.js
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
10. `ErrorState()` - 30 edges

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

## Communities (151 total, 27 thin omitted)

### Community 0 - "AnalyticsPage.jsx"
Cohesion: 0.13
Nodes (12): BarChart(), DonutChart(), F1ScoreGauge(), HealingSuccessRate(), HeatmapCalendar(), LineChart(), MetricCard(), UsageTrendCard() (+4 more)

### Community 1 - "Topbar.jsx"
Cohesion: 0.15
Nodes (8): Topbar(), UserMenu(), appConfig, features, ROUTES, useClickOutside(), pipelineService, TERMINAL_JOB_STATES

### Community 2 - "router.jsx"
Cohesion: 0.11
Nodes (16): disabledPaths, allProtectedRouteDefinitions, appRouteObjects, AppShell(), AuthenticatedRoute(), authPaths, lazyRouteComponents, navigationRouteIds (+8 more)

### Community 3 - "DashboardPage.jsx"
Cohesion: 0.09
Nodes (26): DashboardTaskList(), taskStatus(), TaskCalendar(), policyFailure, toolFailure, ExecutionStatus(), icons, ExecutionTimeline() (+18 more)

### Community 4 - "ChatMessage.jsx"
Cohesion: 0.15
Nodes (7): CanvasHandoffButton(), handleClick(), ValidationBadge(), FlowPreviewCard(), workflowArtifactStatus(), Badge(), saveWorkflowForCanvas()

### Community 5 - "devDependencies"
Cohesion: 0.09
Nodes (23): autoprefixer, @babel/core, @babel/preset-react, @eslint/js, eslint-plugin-react-hooks, globals, jest, jest-environment-jsdom (+15 more)

### Community 6 - "dependencies"
Cohesion: 0.08
Nodes (25): axios, @iconify/react, js-yaml, lucide-react, dependencies, axios, @iconify/react, js-yaml (+17 more)

### Community 7 - "WorkflowBuilderCanvas.jsx"
Cohesion: 0.05
Nodes (52): BuilderModeControls(), getInitialCanvasState(), WorkflowBuilderSurface(), BuilderSidebar(), iconMap, statusMeta, toneClasses, WorkflowToolNode() (+44 more)

### Community 8 - "services/api.js"
Cohesion: 0.19
Nodes (10): apiClient, unwrap(), auditService, icons, tones, integrationService, notificationService, profileService (+2 more)

### Community 9 - "Card.jsx"
Cohesion: 0.20
Nodes (9): Card(), AuditLogTable(), PermissionMatrix(), restrictPermissionsToCaller(), RoleCreateForm(), UserTable(), useUsers(), SecurityPage() (+1 more)

### Community 10 - "FlowPlacementControls.jsx"
Cohesion: 0.18
Nodes (14): canPlaceNode(), flowPlacementModel(), insertionPlacementPreview(), insertionPositionValue(), invalid(), movePlacementPreview(), nodeID(), flow (+6 more)

### Community 11 - "apiErrorMessage"
Cohesion: 0.11
Nodes (18): RegistryBulkImportPanel(), bulkImport, context, status, RegistryGenerationContextViewer(), RegistryStatusBanner(), WorkflowActions(), RegistryContextPage() (+10 more)

### Community 12 - "ResourceState.jsx"
Cohesion: 0.13
Nodes (14): ExecutionFilters(), EmptyState(), ErrorState(), LoadingState(), Tabs(), WorkflowAssignments(), WorkflowFilters(), useDebounce() (+6 more)

### Community 13 - "CompanyPage.jsx"
Cohesion: 0.13
Nodes (16): FormField(), Textarea(), ApprovalTiersTab(), CompanyPage(), CostCentresTab(), DepartmentsTab(), EMPTY_APPROVAL_TIER, EMPTY_COST_CENTRE (+8 more)

### Community 14 - "execution.service.js"
Cohesion: 0.16
Nodes (14): columns, ExecutionTable(), RecordedModelUsage(), initial(), formatDuration(), formatTokens(), normalizeExecution(), reconciliationDate() (+6 more)

### Community 15 - "ChatArtifactPanel.jsx"
Cohesion: 0.15
Nodes (15): Collapsible(), METHOD_COLORS, Pill(), RISK_COLORS, SectionHeader(), ACTION_ICON, DECISION_COLORS, ExampleCard() (+7 more)

### Community 16 - "ui/index.js"
Cohesion: 0.10
Nodes (3): CodeBlock(), EmptyState(), Spinner()

### Community 17 - "useNotifications"
Cohesion: 0.08
Nodes (19): DataTable(), CopyButton(), PendingGenerationApprovalCard(), columns, WorkflowTable(), NotificationContext, NotificationProvider(), useNotifications() (+11 more)

### Community 18 - "ExecutionRunControls.jsx"
Cohesion: 0.16
Nodes (8): ExecutionRunControls(), run, useExecution(), useExecutionMonitor(), eventNames, executionEventLabel(), isActiveExecution(), reconcileExecutionEvents()

### Community 20 - "SettingsPage.jsx"
Cohesion: 0.20
Nodes (9): ApiKeyCard(), IntegrationCard(), LlmModelSelector(), McpConnectionPanel(), WebhookForm(), Toggle(), useSettings(), SettingsPage() (+1 more)

### Community 21 - "user.service.js"
Cohesion: 0.70
Nodes (3): normalizeAdministrationUsers(), normalizePermissionMatrix(), normalizeUser()

### Community 22 - "WorkflowWorkspaceEditor.test.jsx"
Cohesion: 0.07
Nodes (30): asset, manifest, shell, conditionFlow, messages, proposal, record, send (+22 more)

### Community 23 - "executionService"
Cohesion: 0.11
Nodes (14): OperationReconciliationReview(), execution, result, review, completeApprovalDisplay(), RuntimeApprovalReview(), receipt, view (+6 more)

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

### Community 28 - "WorkflowWorkspaceCanvas.jsx"
Cohesion: 0.36
Nodes (6): selectedWorkflowChoice(), workflowChoices(), workflowArtifacts(), workflowSource(), editorProps, WorkflowWorkspaceCanvas()

### Community 30 - "iterationEvidence.js"
Cohesion: 0.16
Nodes (17): collectionRecord(), doneExecution, failedExecution, ExecutionOutputPanel(), IterationNodeEvidence(), labels, Receipt(), fixture() (+9 more)

### Community 34 - "Button.jsx"
Cohesion: 0.13
Nodes (10): Avatar(), Button(), variants, Modal(), UserBadge(), user, UserRow(), TemplateCard() (+2 more)

### Community 79 - "build-hosting.mjs"
Cohesion: 0.08
Nodes (30): artifactDir, base, bindings, config, env, frontendDir, manifest, repositoryDir (+22 more)

### Community 92 - "RuntimeApprovalPolicyPanel.jsx"
Cohesion: 0.10
Nodes (20): keyFor(), PolicyEditor(), PolicyWorkspace(), reload(), save(), restore(), RuntimeApprovalPolicyPanel(), clients (+12 more)

### Community 93 - "CapabilityReviewPanel.jsx"
Cohesion: 0.12
Nodes (23): CapabilityInspector(), CapabilityReviewPanel(), Fields(), fitsInspector(), fullyVisible(), label(), restoreDecision(), ReviewWorkspace() (+15 more)

### Community 94 - "WorkflowWorkspaceEditor.jsx"
Cohesion: 0.19
Nodes (13): flowLoops(), branchDestination(), ConditionFields(), flowConditions(), flowReturns(), same(), ScopeSelect(), source (+5 more)

### Community 95 - "DatafeedPage.jsx"
Cohesion: 0.27
Nodes (7): useSemanticStatus(), DatafeedPage(), formatSeconds(), formatObject(), PipelineConfigPage(), VectorMetricsPage(), semanticService

### Community 96 - "McpConnectionPanel.jsx"
Cohesion: 0.24
Nodes (10): ConnectionWorkspace(), confirm(), run(), send(), keyFor(), readable(), restore(), streamHelp (+2 more)

### Community 97 - "operation-recovery.service.js"
Cohesion: 0.44
Nodes (8): artifact(), date(), deny(), exact(), history(), id(), requirements, text()

### Community 98 - "run-admission.service.js"
Cohesion: 0.15
Nodes (14): AUTH_STORAGE, empty, run, assertAccount(), identity(), locked(), read(), receipt() (+6 more)

### Community 99 - "usePermissions"
Cohesion: 0.22
Nodes (17): WorkflowBuilderCanvas(), ChatArtifactPanel(), CommandPalette(), MobileNav(), Sidebar(), filterNavigationGroups(), RouteContext, routeFromPath() (+9 more)

### Community 100 - "ReadValueFields.jsx"
Cohesion: 0.33
Nodes (9): initialSchema(), kindInitial(), literal(), ReadBindingFields(), ReadValueFields(), reference(), safeKey(), SchemaContractFields() (+1 more)

### Community 101 - "ChatWindow.jsx"
Cohesion: 0.16
Nodes (9): ChatMessage(), attempts, ChatOperationProgress(), stages, toolLabel(), CAPABILITIES, ChatWelcome(), QUICK_PROMPTS (+1 more)

### Community 102 - "ReadSimulationPanel.test.jsx"
Cohesion: 0.22
Nodes (7): ReadSimulationPanel(), loopRecord, loopResponse(), modelResponse(), record, response(), steps

### Community 103 - "ReadableValue.jsx"
Cohesion: 0.35
Nodes (10): Attachment(), equivalentJSON(), inlineMediaTypes, label(), notice(), present(), ReadableResult(), ReadableValue() (+2 more)

### Community 104 - "CollectionPatchPreview.jsx"
Cohesion: 0.18
Nodes (10): CollectionPatchPreview(), summary(), ConditionPatchPreview(), summary(), before, merge, contract(), mapping() (+2 more)

### Community 105 - "CollectionFields.test.jsx"
Cohesion: 0.29
Nodes (7): CollectionFields(), IterationFixturePicker(), config, inner, outer, CollectionInspector(), CollectionWrapForm()

### Community 106 - "useAuthContext"
Cohesion: 0.17
Nodes (16): ChatRequestRevision(), message, source, NodePrompt(), ServerUnreachableBanner(), useAuthContext(), AppLayout(), WorkspaceLayout() (+8 more)

### Community 107 - "DashboardPage.test.jsx"
Cohesion: 0.47
Nodes (5): auth, clients, response(), setup(), task()

### Community 108 - "ModelBranchInsertion.test.jsx"
Cohesion: 0.25
Nodes (3): cases, flow, record

### Community 109 - "SchemaFields.jsx"
Cohesion: 0.31
Nodes (8): compatible(), Field(), initial(), reference(), SchemaFields(), shape(), schema, sources

### Community 110 - "AuthContext.jsx"
Cohesion: 0.06
Nodes (19): App(), queryClient, ErrorBoundary, AuthStateProbe(), getRefreshInFlight(), isNetworkError(), isServerUnavailable(), appRouter (+11 more)

### Community 111 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, build:hosting, demo:local, dev, lint, preview, test (+2 more)

### Community 112 - "EmailDraftPreview.jsx"
Cohesion: 0.24
Nodes (7): EmailDraftPreview(), reasonLabels, reportLabels, draft, sendMessage, useAuth, useAuth()

### Community 113 - "ReadFlowTree.jsx"
Cohesion: 0.27
Nodes (6): predicateLabel(), ReadFlowTree(), collection(), flow, sequence(), steps

### Community 114 - "RolePermissionEditor.jsx"
Cohesion: 0.16
Nodes (7): Checkbox(), Input(), Select(), BUILT_IN_ROLE_IDS, RolePermissionEditor(), permissions, UserForm()

### Community 115 - "config/axios.js"
Cohesion: 0.13
Nodes (5): notify, notify, NON_REFRESHABLE, capabilityService, taskDashboardService

### Community 116 - "ExecutionReviewInboxPage.test.jsx"
Cohesion: 0.25
Nodes (4): clients, getReviewInbox, item, user

### Community 117 - "ExecutionDetailPage.jsx"
Cohesion: 0.13
Nodes (14): HealingReport(), LiveLogStream(), logLine(), OperationRecoveryArtifacts(), saved, source, OperationStatusQueries(), PendingApprovalCard() (+6 more)

### Community 118 - "useChat.js"
Cohesion: 0.17
Nodes (11): useChat(), isActiveChatOperation(), reconcileChatProgress(), useChatOperationMonitor(), createSession, messages, normalSend, record (+3 more)

### Community 119 - "ChatPage.jsx"
Cohesion: 0.29
Nodes (9): ChatHistory(), SaveModifiedWorkflowButton(), ChatSessionItem(), ChatWindow(), useChatSessions(), ChatHistoryPage(), ChatPage(), clearWorkflowForChatEdit() (+1 more)

### Community 120 - "navMatchesRoutePermissions.test.jsx"
Cohesion: 0.40
Nodes (5): hasAnyFor(), ROLE_IDS, ROLES, routeByPath, visibleNavEntries()

### Community 121 - "ReadSimulationPanel.jsx"
Cohesion: 0.29
Nodes (10): collectionOwners(), collectionOutcomes, message(), modelNode(), modelOutcomes, outcomeLabel(), outcomes, SimulationWorkspace() (+2 more)

### Community 122 - "MessageMarkdown.jsx"
Cohesion: 0.33
Nodes (9): CodeBlock(), InlineContent(), isTableSeparator(), looksLikeHtml(), MessageMarkdown(), parseInline(), parseTableRow(), tokenize() (+1 more)

### Community 123 - "navigation.js"
Cohesion: 0.24
Nodes (7): Breadcrumb(), allNavigationGroups, DEFAULT_ROUTE, getNavigationGroup(), groupFeatureFlags, itemFeatureFlags, resolvePermittedRoute()

### Community 124 - "AgentNodeInspector.jsx"
Cohesion: 0.33
Nodes (7): AgentNodeInspector(), integer(), predicateType(), AnalysisNodeInspector(), number(), ModelInputFields(), safeName()

### Community 125 - "ReportPageResolutionReview.jsx"
Cohesion: 0.27
Nodes (6): localNow(), ReportPageResolutionReview(), seed(), execution, resolveReportPage, ExecutionReportPageResolutionPage()

### Community 128 - "cron.utils.js"
Cohesion: 0.29
Nodes (3): DEFAULT_FRIENDLY, WEEKDAY_LABELS, WEEKDAY_NAMES

### Community 129 - "ValueFields.jsx"
Cohesion: 0.29
Nodes (5): PublishedWorkflowRunForm(), defaults, Field(), kind(), ValueFields()

### Community 131 - "WorkflowEditHistory.jsx"
Cohesion: 0.27
Nodes (8): errorText(), labels, entry, page, record, source, WorkflowEditHistory(), parseWorkflowPreview()

### Community 132 - "package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 133 - "WorkflowRunReceipt.jsx"
Cohesion: 0.31
Nodes (6): WorkflowRunReceipt(), useRunAdmissionRecovery(), canDismissRecordedRun(), empty, receipt, useWorkflowDetailRun()

### Community 134 - "McpConnectionPanel.test.jsx"
Cohesion: 0.25
Nodes (5): clients, command, connection(), page(), status

### Community 135 - "permissionParity.test.jsx"
Cohesion: 0.22
Nodes (7): notify, permissions, rebuild, registryCreate, registryLoad, registryStatus, registryUpdate

### Community 136 - "ChatMessageVisualisation.jsx"
Cohesion: 0.25
Nodes (3): InlineSources(), InlineVisualisation(), PIE_COLORS

## Knowledge Gaps
- **287 isolated node(s):** `baseUrl`, `paths`, `src`, `name`, `private` (+282 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **27 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `apiClient` connect `services/api.js` to `Topbar.jsx`, `execution-reconciliation.service.test.js`, `permissionParity.test.jsx`, `operation-recovery.service.test.js`, `apiErrorMessage`, `ResourceState.jsx`, `execution.service.js`, `SettingsPage.jsx`, `user.service.js`, `WorkflowWorkspaceEditor.test.jsx`, `executionService`, `workflow.service.js`, `WorkflowSchedulePanel.jsx`, `execution-review.service.js`, `RuntimeApprovalPolicyPanel.jsx`, `McpConnectionPanel.jsx`, `operation-recovery.service.js`, `run-admission.service.js`, `DashboardPage.test.jsx`, `AuthContext.jsx`, `config/axios.js`, `useChat.js`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `usePermissions()` connect `usePermissions` to `McpConnectionPanel.jsx`, `router.jsx`, `DashboardPage.jsx`, `Card.jsx`, `useAuthContext`, `apiErrorMessage`, `ResourceState.jsx`, `CompanyPage.jsx`, `ChatArtifactPanel.jsx`, `SettingsPage.jsx`, `ExecutionDetailPage.jsx`, `ReportPageResolutionReview.jsx`, `executionService`, `RuntimeApprovalPolicyPanel.jsx`, `CapabilityReviewPanel.jsx`, `DatafeedPage.jsx`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `workflowService` connect `ResourceState.jsx` to `run-admission.service.js`, `WorkflowEditHistory.jsx`, `ChatMessage.jsx`, `WorkflowRunReceipt.jsx`, `ReadSimulationPanel.test.jsx`, `WorkflowBuilderCanvas.jsx`, `apiErrorMessage`, `ModelBranchInsertion.test.jsx`, `useNotifications`, `WorkflowWorkspaceEditor.test.jsx`, `WorkflowSchedulePanel.jsx`, `workflow.service.js`, `ReadSimulationPanel.jsx`, `useChat.js`, `WorkflowWorkspaceEditor.jsx`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `baseUrl`, `paths`, `src` to the rest of the system?**
  _287 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AnalyticsPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `router.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `DashboardPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08788159111933395 - nodes in this community are weakly interconnected._