function AuthLayout({ children, title = "Agentic Workflow Engine" }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-backgroundLight px-4 dark:bg-darkBackgroundVery">
      <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-soft dark:border-gray-800 dark:bg-darkBackground">
        <h1 className="mb-6 text-2xl font-semibold text-gray-900 dark:text-white">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}

export default AuthLayout;
