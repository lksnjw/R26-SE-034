# Graph Report - frontend  (2026-10-11)

## Corpus Check
- 497 files · ~176,466 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1677 nodes · 3832 edges · 152 communities (123 shown, 29 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `05451d17`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AnalyticsPage.jsx
- AuthContext.jsx
- EmptyState.jsx
- DashboardPage.jsx
- ChatMessage.jsx
- devDependencies
- dependencies
- WorkflowBuilderCanvas.jsx
- apiClient
- useAuthContext
- FlowPlacementControls.jsx
- RegistryPage.jsx
- ui/index.js
- CompanyPage.jsx
- execution.service.js
- ProtectedPatchPreview.jsx
- apiErrorMessage
- SettingsPage.jsx
- WorkflowRunReceipt.jsx
- nodes/index.js
- navigation.js
- useNotifications
- operation-readback.service.js
- useWorkflowDetailRun.js
- workflow.service.js
- WorkflowSchedulePanel.jsx
- compilerOptions
- execution-review.service.js
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
- WorkflowWorkspaceEditor.jsx
- MessageMarkdown.jsx
- McpConnectionPanel.jsx
- EmailDraftPreview.jsx
- run-admission.service.js
- RouteContext.jsx
- AgentNodeInspector.jsx
- ChatWindow.jsx
- ReadSimulationPanel.test.jsx
- ReadableValue.jsx
- Card.jsx
- ReadSimulationPanel.jsx
- ReadValueFields.jsx
- CollectionFields.jsx
- ModelBranchInsertion.test.jsx
- SchemaFields.jsx
- app.js
- scripts
- operation-recovery.service.js
- iterationEvidence.js
- Button.jsx
- OperationReconciliationReview.jsx
- ExecutionReviewInboxPage.test.jsx
- WorkflowWorkspaceEditor.test.jsx
- useChat.js
- ChatHistory.jsx
- WorkflowActions.jsx
- ChatPage.jsx
- ReadFlowTree.test.jsx
- permissionParity.test.jsx
- config/axios.js
- router.jsx
- useChat.test.jsx
- WorkflowListPage.jsx
- cron.utils.js
- ReportPageResolutionReview.jsx
- authenticatedReturnTarget
- mcp-connection.service.js
- package.json
- user.service.js
- Spinner.jsx
- protected-approval-review.test.js
- usePermissions
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
- `initial()` --calls--> `normalizeExecution()`  [EXTRACTED]
  src/components/workflows/WorkflowRunReceipt.test.jsx → src/services/execution.service.js
- `AuthStateProbe()` --calls--> `useAuthContext()`  [EXTRACTED]
  src/config/authRace.test.js → src/context/AuthContext.jsx
- `WorkflowBuilderPage()` --calls--> `useRoute()`  [EXTRACTED]
  src/pages/workflows/WorkflowBuilderPage.jsx → src/context/RouteContext.jsx

## Import Cycles
- None detected.

## Communities (152 total, 29 thin omitted)

### Community 0 - "AnalyticsPage.jsx"
Cohesion: 0.13
Nodes (12): BarChart(), DonutChart(), F1ScoreGauge(), HealingSuccessRate(), HeatmapCalendar(), LineChart(), MetricCard(), UsageTrendCard() (+4 more)

### Community 1 - "AuthContext.jsx"
Cohesion: 0.11
Nodes (9): AuthStateProbe(), getRefreshInFlight(), isNetworkError(), isServerUnavailable(), AuthContext, AuthProvider(), loadCurrentUser(), loadStoredUser() (+1 more)

### Community 3 - "DashboardPage.jsx"
Cohesion: 0.08
Nodes (29): DashboardTaskList(), taskStatus(), TaskCalendar(), policyFailure, toolFailure, ExecutionStatus(), icons, ExecutionTimeline() (+21 more)

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
Cohesion: 0.06
Nodes (50): BuilderModeControls(), getInitialCanvasState(), WorkflowBuilderCanvas(), WorkflowBuilderSurface(), BuilderSidebar(), iconMap, statusMeta, toneClasses (+42 more)

### Community 8 - "apiClient"
Cohesion: 0.15
Nodes (11): apiClient, unwrap(), auditService, capabilityService, icons, tones, integrationService, profileService (+3 more)

### Community 9 - "useAuthContext"
Cohesion: 0.13
Nodes (13): Topbar(), ServerUnreachableBanner(), AuthenticatedRoute(), useAuthContext(), ThemeContext, useTheme(), AppLayout(), AuthLayout() (+5 more)

### Community 10 - "FlowPlacementControls.jsx"
Cohesion: 0.18
Nodes (14): canPlaceNode(), flowPlacementModel(), insertionPlacementPreview(), insertionPositionValue(), invalid(), movePlacementPreview(), nodeID(), flow (+6 more)

### Community 11 - "RegistryPage.jsx"
Cohesion: 0.11
Nodes (15): RegistryBulkImportPanel(), bulkImport, context, status, RegistryGenerationContextViewer(), RegistryStatusBanner(), RegistryContextPage(), RegistryImportPage() (+7 more)

### Community 13 - "CompanyPage.jsx"
Cohesion: 0.13
Nodes (16): FormField(), Textarea(), ApprovalTiersTab(), CompanyPage(), CostCentresTab(), DepartmentsTab(), EMPTY_APPROVAL_TIER, EMPTY_COST_CENTRE (+8 more)

### Community 14 - "execution.service.js"
Cohesion: 0.20
Nodes (13): columns, ExecutionTable(), RecordedModelUsage(), formatDuration(), formatTokens(), normalizeExecution(), reconciliationDate(), reconciliationExact() (+5 more)

### Community 15 - "ProtectedPatchPreview.jsx"
Cohesion: 0.14
Nodes (15): CollectionPatchPreview(), summary(), ConditionPatchPreview(), summary(), before, merge, ProtectedPatchPreview(), summary() (+7 more)

### Community 16 - "apiErrorMessage"
Cohesion: 0.19
Nodes (13): Checkbox(), restrictPermissionsToCaller(), RoleCreateForm(), BUILT_IN_ROLE_IDS, RolePermissionEditor(), permissions, UserForm(), UserRow() (+5 more)

### Community 17 - "SettingsPage.jsx"
Cohesion: 0.12
Nodes (14): ApiKeyCard(), IntegrationCard(), LlmModelSelector(), WebhookForm(), DataTable(), Toggle(), useSettings(), COLUMNS (+6 more)

### Community 18 - "WorkflowRunReceipt.jsx"
Cohesion: 0.12
Nodes (10): ExecutionOutputPanel(), initial(), WorkflowRunReceipt(), useExecution(), useExecutionMonitor(), ExecutionLogsPage(), eventNames, executionEventLabel() (+2 more)

### Community 20 - "navigation.js"
Cohesion: 0.14
Nodes (17): Sidebar(), hasAnyFor(), ROLE_IDS, ROLES, routeByPath, visibleNavEntries(), AppShell(), lazyRouteComponents (+9 more)

### Community 21 - "useNotifications"
Cohesion: 0.13
Nodes (10): CopyButton(), TemplateCard(), NotificationContext, useNotifications(), CsvUploadCard(), DOCUMENT_TYPES, DocumentUploadCard(), SENSITIVITY_LEVELS (+2 more)

### Community 22 - "operation-readback.service.js"
Cohesion: 0.08
Nodes (29): asset, manifest, shell, labels, outcomes, StatusQueries(), time(), pending() (+21 more)

### Community 23 - "useWorkflowDetailRun.js"
Cohesion: 0.23
Nodes (9): empty, run, useRunAdmissionRecovery(), canDismissRecordedRun(), empty, receipt, useWorkflowDetailRun(), RUN_ADMISSION_CHANGED (+1 more)

### Community 24 - "workflow.service.js"
Cohesion: 0.12
Nodes (13): notify, entry, page, record, source, createSession, messages, normalSend (+5 more)

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
Cohesion: 0.18
Nodes (6): App(), queryClient, ErrorBoundary, appRouter, NotificationProvider(), ThemeProvider()

### Community 30 - "WorkflowWorkspaceCanvas.jsx"
Cohesion: 0.24
Nodes (11): selectedWorkflowChoice(), workflowChoices(), errorText(), labels, WorkflowEditHistory(), parseWorkflowPreview(), workflowArtifacts(), workflowSource() (+3 more)

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

### Community 94 - "WorkflowWorkspaceEditor.jsx"
Cohesion: 0.13
Nodes (21): flowLoops(), branchDestination(), ConditionFields(), flowConditions(), flowReturns(), same(), ScopeSelect(), source (+13 more)

### Community 95 - "MessageMarkdown.jsx"
Cohesion: 0.30
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

### Community 99 - "RouteContext.jsx"
Cohesion: 0.17
Nodes (15): ChatArtifactPanel(), Breadcrumb(), CommandPalette(), MobileNav(), UserMenu(), getNavigationGroup(), RouteContext, routeFromPath() (+7 more)

### Community 100 - "AgentNodeInspector.jsx"
Cohesion: 0.31
Nodes (8): AgentNodeInspector(), integer(), predicateType(), AnalysisNodeInspector(), number(), ModelInputFields(), safeName(), NodePrompt()

### Community 101 - "ChatWindow.jsx"
Cohesion: 0.20
Nodes (9): ChatMessage(), SaveModifiedWorkflowButton(), CAPABILITIES, ChatWelcome(), ChatWindow(), QUICK_PROMPTS, loadModels, clearWorkflowForChatEdit() (+1 more)

### Community 102 - "ReadSimulationPanel.test.jsx"
Cohesion: 0.21
Nodes (8): loopRecord, loopResponse(), modelResponse(), protectedRecord, protectedResponse(), record, response(), steps

### Community 103 - "ReadableValue.jsx"
Cohesion: 0.22
Nodes (14): Attachment(), equivalentJSON(), inlineMediaTypes, label(), notice(), present(), ReadableResult(), ReadableValue() (+6 more)

### Community 104 - "Card.jsx"
Cohesion: 0.16
Nodes (8): LiveLogStream(), logLine(), Card(), CodeBlock(), AuditLogTable(), PermissionMatrix(), PendingGenerationApprovalCard(), WorkflowAssignments()

### Community 105 - "ReadSimulationPanel.jsx"
Cohesion: 0.22
Nodes (14): protectedSimulationBoundary(), protectedSimulationLabels, simulationFixturePayload(), validProtectedTraceEntry(), collectionOutcomes, message(), modelNode(), modelOutcomes (+6 more)

### Community 106 - "ReadValueFields.jsx"
Cohesion: 0.33
Nodes (9): initialSchema(), kindInitial(), literal(), ReadBindingFields(), ReadValueFields(), reference(), safeKey(), SchemaContractFields() (+1 more)

### Community 107 - "CollectionFields.jsx"
Cohesion: 0.27
Nodes (8): CollectionFields(), collectionOwners(), IterationFixturePicker(), config, inner, outer, CollectionInspector(), CollectionWrapForm()

### Community 108 - "ModelBranchInsertion.test.jsx"
Cohesion: 0.25
Nodes (3): cases, flow, record

### Community 109 - "SchemaFields.jsx"
Cohesion: 0.16
Nodes (14): isOperationProfile(), PublishedWorkflowRunForm(), compatible(), Field(), initial(), reference(), SchemaFields(), shape() (+6 more)

### Community 110 - "app.js"
Cohesion: 0.16
Nodes (7): appConfig, features, disabledPaths, appRouteObjects, ROUTES, pipelineService, TERMINAL_JOB_STATES

### Community 111 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, build:hosting, demo:local, dev, lint, preview, test (+2 more)

### Community 112 - "operation-recovery.service.js"
Cohesion: 0.19
Nodes (14): OperationRecoveryArtifacts(), saved, source, artifact(), date(), deny(), exact(), history() (+6 more)

### Community 113 - "iterationEvidence.js"
Cohesion: 0.25
Nodes (12): collectionRecord(), doneExecution, failedExecution, fixture(), address(), failedModel(), iterationFixture(), projectExecutionIterationEvidence() (+4 more)

### Community 114 - "Button.jsx"
Cohesion: 0.14
Nodes (8): Avatar(), Button(), variants, Modal(), UserBadge(), user, initials(), ProfilePage()

### Community 115 - "OperationReconciliationReview.jsx"
Cohesion: 0.15
Nodes (11): OperationReconciliationEvidence(), reconciliationOutcomeLabel(), OperationReconciliationReview(), execution, result, review, PendingApprovalCard(), completeApprovalDisplay() (+3 more)

### Community 116 - "ExecutionReviewInboxPage.test.jsx"
Cohesion: 0.25
Nodes (4): clients, getReviewInbox, item, user

### Community 117 - "WorkflowWorkspaceEditor.test.jsx"
Cohesion: 0.14
Nodes (7): conditionFlow, messages, proposal, protectedChatRecord(), protectedRecord(), record, send

### Community 118 - "useChat.js"
Cohesion: 0.18
Nodes (11): attempts, ChatOperationProgress(), stages, toolLabel(), useChat(), isActiveChatOperation(), reconcileChatProgress(), useChatOperationMonitor() (+3 more)

### Community 119 - "ChatHistory.jsx"
Cohesion: 0.39
Nodes (4): ChatHistory(), ChatSessionItem(), useChatSessions(), ChatHistoryPage()

### Community 120 - "WorkflowActions.jsx"
Cohesion: 0.29
Nodes (6): TraceIdentifier(), failureItems(), GateRejectionAlert(), ruleIdFor(), WorkflowActions(), apiErrorDetails()

### Community 121 - "ChatPage.jsx"
Cohesion: 0.28
Nodes (13): ChatCreationState(), ChatRequestRevision(), message, source, ChatPage(), pending, prepareChatCommand(), acknowledgeChatCreation() (+5 more)

### Community 122 - "ReadFlowTree.test.jsx"
Cohesion: 0.31
Nodes (6): action(), collection(), flow, protectedFlow(), sequence(), steps

### Community 123 - "permissionParity.test.jsx"
Cohesion: 0.22
Nodes (7): notify, permissions, rebuild, registryCreate, registryLoad, registryStatus, registryUpdate

### Community 124 - "config/axios.js"
Cohesion: 0.18
Nodes (5): notify, notify, NON_REFRESHABLE, chatService, value

### Community 125 - "router.jsx"
Cohesion: 0.11
Nodes (16): EmptyState(), ErrorState(), LoadingState(), allProtectedRouteDefinitions, authPaths, navigationRouteIds, protectedChildren, PERMISSIONS (+8 more)

### Community 127 - "WorkflowListPage.jsx"
Cohesion: 0.16
Nodes (10): ExecutionFilters(), HealingReport(), Tabs(), WorkflowFilters(), columns, WorkflowTable(), useDebounce(), useWorkflow() (+2 more)

### Community 128 - "cron.utils.js"
Cohesion: 0.29
Nodes (3): DEFAULT_FRIENDLY, WEEKDAY_LABELS, WEEKDAY_NAMES

### Community 129 - "ReportPageResolutionReview.jsx"
Cohesion: 0.32
Nodes (5): localNow(), ReportPageResolutionReview(), seed(), execution, resolveReportPage

### Community 132 - "package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 133 - "user.service.js"
Cohesion: 0.70
Nodes (3): normalizeAdministrationUsers(), normalizePermissionMatrix(), normalizeUser()

### Community 135 - "protected-approval-review.test.js"
Cohesion: 0.29
Nodes (4): bounded(), date(), exact(), validProtectedApprovalReview()

### Community 139 - "usePermissions"
Cohesion: 0.20
Nodes (11): OperationStatusQueries(), ProtectedScreen(), usePermissions(), ExecutionApprovalReviewPage(), ExecutionDetailPage(), ExecutionRunDetail(), ExecutionReconciliationPage(), ExecutionReportPageResolutionPage() (+3 more)

### Community 153 - "executionService"
Cohesion: 0.12
Nodes (11): ExecutionRunControls(), run, Receipt(), useExecution, clients, permissions, view, observation (+3 more)

## Knowledge Gaps
- **298 isolated node(s):** `baseUrl`, `paths`, `src`, `name`, `private` (+293 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **29 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `usePermissions()` connect `usePermissions` to `McpConnectionPanel.jsx`, `ChatArtifactPanel.jsx`, `RouteContext.jsx`, `DashboardPage.jsx`, `Card.jsx`, `useAuthContext`, `RegistryPage.jsx`, `CompanyPage.jsx`, `apiErrorMessage`, `navigation.js`, `router.jsx`, `WorkflowActions.jsx`, `RuntimeApprovalPolicyPanel.jsx`, `CapabilityReviewPanel.jsx`, `WorkflowListPage.jsx`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `apiClient` connect `apiClient` to `AuthContext.jsx`, `DashboardPage.jsx`, `mcp-connection.service.js`, `user.service.js`, `protected-approval-review.test.js`, `refreshRotation.test.js`, `RegistryPage.jsx`, `execution.service.js`, `SettingsPage.jsx`, `operation-readback.service.js`, `workflow.service.js`, `executionService`, `WorkflowSchedulePanel.jsx`, `execution-review.service.js`, `RuntimeApprovalPolicyPanel.jsx`, `run-admission.service.js`, `RouteContext.jsx`, `operation-recovery.service.js`, `permissionParity.test.jsx`, `config/axios.js`, `router.jsx`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `Card()` connect `Card.jsx` to `AnalyticsPage.jsx`, `DashboardPage.jsx`, `ChatMessage.jsx`, `usePermissions`, `CompanyPage.jsx`, `apiErrorMessage`, `SettingsPage.jsx`, `WorkflowRunReceipt.jsx`, `Button.jsx`, `useNotifications`, `WorkflowSchedulePanel.jsx`, `router.jsx`, `WorkflowListPage.jsx`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `baseUrl`, `paths`, `src` to the rest of the system?**
  _298 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `AnalyticsPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `AuthContext.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `DashboardPage.jsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._