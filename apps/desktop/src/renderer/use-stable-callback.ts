import { useCallback, useLayoutEffect, useRef } from "react";

/** Keep child event props stable while dispatching to the latest committed render. */
export function useStableCallback<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const committedHandler = useRef(handler);
  useLayoutEffect(() => {
    committedHandler.current = handler;
  }, [handler]);
  return useCallback((...args: Args): Result => committedHandler.current(...args), []);
}
