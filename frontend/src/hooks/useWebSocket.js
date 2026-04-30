export function useWebSocket() {
  return {
    readyState: "mock-connected",
    sendJsonMessage: () => undefined,
    lastJsonMessage: null,
  };
}

export default useWebSocket;
