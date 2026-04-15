import { useState } from "react";

export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  return { isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false) };
}

export default useCommandPalette;
