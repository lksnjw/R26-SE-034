import type { RepositoryState } from "../repository/store.js";
import { withFunctionResources, type FunctionComposition } from "./invocation.js";

/** A state capability, deliberately not a Repository. No retained image,
 * persistence authority, synchronous dispatch guard or synthetic observers. */
export interface StatePhases {
  read<T>(read: (state: Readonly<RepositoryState>) => T): Promise<T>;
  mutate<T>(write: (state: RepositoryState) => T): Promise<T>;
  mutateExecution<T>(executionId: string, write: (state: RepositoryState) => T): Promise<T>;
}

export function functionStatePhases(input: FunctionComposition): StatePhases {
  return Object.freeze({
    read: <T>(read: (state: Readonly<RepositoryState>) => T) => withFunctionResources(input,
      async ({ repository }) => structuredClone(await repository.readAuthoritative(read))),
    mutate: <T>(write: (state: RepositoryState) => T) => withFunctionResources(input,
      async ({ repository }) => structuredClone(await repository.mutate(write))),
    mutateExecution: <T>(id: string, write: (state: RepositoryState) => T) => withFunctionResources(input,
      async ({ repository }) => structuredClone(await repository.mutateExecution(id, write))),
  });
}
