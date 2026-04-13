function FullscreenLayout({ children }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-white dark:bg-darkBackgroundVery">
      {children}
    </div>
  );
}

export default FullscreenLayout;
