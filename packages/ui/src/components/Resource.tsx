import type { ReactNode } from 'react';
import { ErrorState, LoadingRows } from './primitives.js';

/**
 * The three states every screen must handle, in one place (§41).
 *
 * Loading, error and empty are the states users actually meet; components that only
 * render the happy path turn a failed request into a blank panel. `Resource` makes the
 * correct behaviour the default: a failed request shows the API's message and a retry,
 * an empty response shows an explanation of *why* it is empty.
 */
export interface ResourceState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: unknown;
  refetch?: () => void;
}

export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function Resource<T>({
  state,
  children,
  loading,
  empty,
  isEmpty,
}: {
  state: ResourceState<T>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  /** Shown when `isEmpty(data)` returns true; defaults to "no data". */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}): ReactNode {
  if (state.isLoading && state.data === undefined) return <>{loading ?? <LoadingRows />}</>;
  const message = errorMessage(state.error);
  if (message) return <ErrorState title="Could not load this view" detail={message} retry={state.refetch} />;
  if (state.data === undefined) return <>{loading ?? <LoadingRows />}</>;
  if (isEmpty?.(state.data)) return <>{empty ?? null}</>;
  return <>{children(state.data)}</>;
}

/** A muted, single-line degradation note used inside panels. */
export function Note({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-3 py-2 text-[11px] text-faint">{children}</div>;
}
