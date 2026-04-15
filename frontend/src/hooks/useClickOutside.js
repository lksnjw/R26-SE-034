import { useEffect } from "react";

export function useClickOutside(ref, onClickOutside) {
  useEffect(() => {
    const handler = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        onClickOutside?.(event);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClickOutside, ref]);
}

export default useClickOutside;
