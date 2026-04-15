function CodeBlock({ code }) {
  return (
    <pre className="overflow-auto rounded-2xl bg-gray-950 p-4 text-xs leading-6 text-gray-100">
      <code>{code}</code>
    </pre>
  );
}

export default CodeBlock;
