export enum ExitCode {
  Success = 0,
  UserConfig = 1,
  Parser = 2,
  ProviderApi = 3,
  VectorDb = 4,
  Integrity = 5,
}

export class AutoEmbedError extends Error {
  readonly exitCode: ExitCode;
  readonly hint?: string;

  constructor(message: string, exitCode: ExitCode = ExitCode.UserConfig, hint?: string) {
    super(message);
    this.name = "AutoEmbedError";
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function isAutoEmbedError(err: unknown): err is AutoEmbedError {
  return err instanceof AutoEmbedError;
}
