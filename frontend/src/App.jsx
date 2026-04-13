import AppLayout from "./layouts/AppLayout";
import DashboardPage from "./pages/dashboard/DashboardPage";
import WorkflowListPage from "./pages/workflows/WorkflowListPage";
import WorkflowDetailPage from "./pages/workflows/WorkflowDetailPage";
import WorkflowBuilderPage from "./pages/workflows/WorkflowBuilderPage";
import WorkflowTemplatePage from "./pages/workflows/WorkflowTemplatePage";
import ChatPage from "./pages/chat/ChatPage";
import ExecutionListPage from "./pages/executions/ExecutionListPage";
import ExecutionLogsPage from "./pages/executions/ExecutionLogsPage";
import AnalyticsPage from "./pages/analytics/AnalyticsPage";
import UserListPage from "./pages/users/UserListPage";
import SettingsPage from "./pages/settings/SettingsPage";
import ProfilePage from "./pages/profile/ProfilePage";
import NotFoundPage from "./pages/errors/NotFoundPage";
import { ThemeProvider } from "./context/ThemeContext";
import { RouteProvider, useRoute } from "./context/RouteContext";
import { NotificationProvider } from "./context/NotificationContext";

const routeComponents = {
  "dashboard.overview": DashboardPage,
  "dashboard.activity": DashboardPage,
  "workflows.list": WorkflowListPage,
  "workflows.builder": WorkflowBuilderPage,
  "workflows.templates": WorkflowTemplatePage,
  "workflows.detail": WorkflowDetailPage,
  "chat.session": ChatPage,
  "chat.history": ChatPage,
  "executions.history": ExecutionListPage,
  "executions.live": ExecutionLogsPage,
  "executions.healing": ExecutionLogsPage,
  "analytics.performance": AnalyticsPage,
  "analytics.usage": AnalyticsPage,
  "analytics.healing": AnalyticsPage,
  "users.directory": UserListPage,
  "users.roles": UserListPage,
  "users.audit": UserListPage,
  "settings.general": SettingsPage,
  "settings.integrations": SettingsPage,
  "settings.llm": SettingsPage,
  "profile.profile": ProfilePage,
  "profile.security": ProfilePage,
};

function ActivePage() {
  const { activeMain, activeSub } = useRoute();
  const Page = routeComponents[`${activeMain}.${activeSub}`] ?? NotFoundPage;

  return <Page />;
}

function App() {
  return (
    <ThemeProvider>
      <NotificationProvider>
        <RouteProvider>
          <AppLayout>
            <ActivePage />
          </AppLayout>
        </RouteProvider>
      </NotificationProvider>
    </ThemeProvider>
  );
}

export default App;
