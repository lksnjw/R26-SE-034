import { useEffect } from "react";

export function useKeyboardShortcut(key, callback) {
  useEffect(() => {
    const handler = (event) => {
      if (event.key.toLowerCase() === key.toLowerCase()) {
        callback?.(event);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [callback, key]);
}

export default useKeyboardShortcut;
