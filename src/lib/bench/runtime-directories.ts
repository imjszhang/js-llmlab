/** Names reserved for candidate-created Python environments, never frozen fixture inputs. */
export const RUNTIME_DIRECTORY_NAMES: readonly string[] = [".venv", "venv"];

export function isNewRuntimeDirectory(name: string, relative: string, originalPaths: readonly string[]): boolean {
  return RUNTIME_DIRECTORY_NAMES.includes(name)
    && !originalPaths.some((original) => original === relative || original.startsWith(`${relative}/`));
}
